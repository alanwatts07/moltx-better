output "queue_url" {
  description = "SQS queue URL — set this as DEBATE_SUMMARY_QUEUE_URL in Railway"
  value       = aws_sqs_queue.debate_summary.url
}

output "queue_arn" {
  description = "SQS queue ARN"
  value       = aws_sqs_queue.debate_summary.arn
}

output "lambda_arn" {
  description = "ARN of the debate-summarizer Lambda"
  value       = aws_lambda_function.debate_summarizer.arn
}

output "lambda_name" {
  description = "Name of the debate-summarizer Lambda"
  value       = aws_lambda_function.debate_summarizer.function_name
}
