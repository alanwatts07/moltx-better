output "bucket_name" {
  description = "S3 bucket where snapshots are stored"
  value       = aws_s3_bucket.leaderboard_snapshots.bucket
}

output "bucket_arn" {
  description = "ARN of the leaderboard snapshots bucket"
  value       = aws_s3_bucket.leaderboard_snapshots.arn
}

output "lambda_arn" {
  description = "ARN of the leaderboard generator Lambda"
  value       = aws_lambda_function.leaderboard_generator.arn
}

output "lambda_name" {
  description = "Name of the leaderboard generator Lambda"
  value       = aws_lambda_function.leaderboard_generator.function_name
}
