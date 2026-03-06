terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ─────────────────────────────────────────────
# SQS — Debate summary queue
# ─────────────────────────────────────────────

resource "aws_sqs_queue" "debate_summary" {
  name                       = "clawbr-debate-summary-queue"
  visibility_timeout_seconds = 120   # longer than Lambda timeout
  message_retention_seconds  = 86400 # 1 day — if Lambda is down, retry next day
  receive_wait_time_seconds  = 20    # long polling — cheaper, faster

  tags = {
    Project     = "clawbr"
    Component   = "debate-summaries"
    ManagedBy   = "terraform"
  }
}

# ─────────────────────────────────────────────
# IAM — Least-privilege Lambda execution role
# ─────────────────────────────────────────────

resource "aws_iam_role" "summarizer_lambda" {
  name = "clawbr-summarizer-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Project   = "clawbr"
    Component = "debate-summaries"
  }
}

# SQS consume permissions
resource "aws_iam_role_policy" "summarizer_lambda_sqs" {
  name = "clawbr-summarizer-sqs-consume"
  role = aws_iam_role.summarizer_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.debate_summary.arn
      }
    ]
  })
}

# CloudWatch logs
resource "aws_iam_role_policy_attachment" "summarizer_lambda_logs" {
  role       = aws_iam_role.summarizer_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ─────────────────────────────────────────────
# Lambda — Debate summarizer
# ─────────────────────────────────────────────

data "archive_file" "summarizer_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.build/summarizer_lambda.zip"
}

resource "aws_lambda_function" "debate_summarizer" {
  function_name = "clawbr-debate-summarizer"
  description   = "Generates AI debate summaries and updates ballot posts in DB"

  filename         = data.archive_file.summarizer_lambda.output_path
  source_code_hash = data.archive_file.summarizer_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.summarizer_lambda.arn

  memory_size = 256
  timeout     = 90 # two Anthropic calls in parallel, give headroom

  environment {
    variables = {
      DATABASE_URL      = var.database_url
      ANTHROPIC_API_KEY = var.anthropic_api_key
    }
  }

  tags = {
    Project     = "clawbr"
    Component   = "debate-summaries"
    ManagedBy   = "terraform"
  }
}

# SQS → Lambda event source mapping
resource "aws_lambda_event_source_mapping" "sqs_to_summarizer" {
  event_source_arn = aws_sqs_queue.debate_summary.arn
  function_name    = aws_lambda_function.debate_summarizer.arn
  batch_size       = 1 # one debate per invocation — simpler, cleaner logs
}
