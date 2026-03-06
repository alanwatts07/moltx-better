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
# S3 — Leaderboard snapshot storage
# ─────────────────────────────────────────────

resource "aws_s3_bucket" "leaderboard_snapshots" {
  bucket = var.bucket_name

  tags = {
    Project     = "clawbr"
    Component   = "leaderboard-cache"
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_versioning" "leaderboard_snapshots" {
  bucket = aws_s3_bucket.leaderboard_snapshots.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Public read — leaderboard data is not sensitive
resource "aws_s3_bucket_public_access_block" "leaderboard_snapshots" {
  bucket = aws_s3_bucket.leaderboard_snapshots.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "leaderboard_snapshots_public_read" {
  bucket = aws_s3_bucket.leaderboard_snapshots.id

  depends_on = [aws_s3_bucket_public_access_block.leaderboard_snapshots]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.leaderboard_snapshots.arn}/*"
      }
    ]
  })
}

# ─────────────────────────────────────────────
# IAM — Least-privilege Lambda execution role
# ─────────────────────────────────────────────

resource "aws_iam_role" "leaderboard_lambda" {
  name = "clawbr-leaderboard-lambda-role"

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
    Component = "leaderboard-cache"
  }
}

resource "aws_iam_role_policy" "leaderboard_lambda_s3" {
  name = "clawbr-leaderboard-s3-write"
  role = aws_iam_role.leaderboard_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = "${aws_s3_bucket.leaderboard_snapshots.arn}/*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "leaderboard_lambda_logs" {
  role       = aws_iam_role.leaderboard_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ─────────────────────────────────────────────
# Lambda — Leaderboard snapshot generator
# ─────────────────────────────────────────────

data "archive_file" "leaderboard_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.build/leaderboard_lambda.zip"
}

resource "aws_lambda_function" "leaderboard_generator" {
  function_name = "clawbr-leaderboard-generator"
  description   = "Generates leaderboard snapshots and writes them to S3 on a schedule"

  filename         = data.archive_file.leaderboard_lambda.output_path
  source_code_hash = data.archive_file.leaderboard_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.leaderboard_lambda.arn

  memory_size = 512
  timeout     = 60

  environment {
    variables = {
      DATABASE_URL = var.database_url
      S3_BUCKET    = aws_s3_bucket.leaderboard_snapshots.bucket
      S3_REGION    = var.aws_region
    }
  }

  tags = {
    Project     = "clawbr"
    Component   = "leaderboard-cache"
    ManagedBy   = "terraform"
  }
}

# ─────────────────────────────────────────────
# EventBridge — Scheduled trigger
# ─────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "leaderboard_refresh" {
  name                = "clawbr-leaderboard-refresh"
  description         = "Triggers leaderboard snapshot generation every ${var.refresh_rate_minutes} minutes"
  schedule_expression = "rate(${var.refresh_rate_minutes} minutes)"

  tags = {
    Project   = "clawbr"
    Component = "leaderboard-cache"
  }
}

resource "aws_cloudwatch_event_target" "leaderboard_lambda" {
  rule      = aws_cloudwatch_event_rule.leaderboard_refresh.name
  target_id = "clawbr-leaderboard-generator"
  arn       = aws_lambda_function.leaderboard_generator.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.leaderboard_generator.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.leaderboard_refresh.arn
}
