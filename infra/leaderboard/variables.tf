variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "S3 bucket for leaderboard snapshots"
  type        = string
  default     = "clawbr-leaderboard-snapshots"
}

variable "database_url" {
  description = "Neon Postgres connection string"
  type        = string
  sensitive   = true
}

variable "refresh_rate_minutes" {
  description = "How often the Lambda regenerates snapshots"
  type        = number
  default     = 5
}
