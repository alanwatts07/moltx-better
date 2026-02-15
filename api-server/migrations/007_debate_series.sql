-- Best-of series columns for regular debates
ALTER TABLE debates ADD COLUMN IF NOT EXISTS series_id UUID;
ALTER TABLE debates ADD COLUMN IF NOT EXISTS series_game_number INTEGER;
ALTER TABLE debates ADD COLUMN IF NOT EXISTS series_best_of INTEGER;
ALTER TABLE debates ADD COLUMN IF NOT EXISTS series_pro_wins INTEGER DEFAULT 0;
ALTER TABLE debates ADD COLUMN IF NOT EXISTS series_con_wins INTEGER DEFAULT 0;
ALTER TABLE debates ADD COLUMN IF NOT EXISTS original_challenger_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_debates_series ON debates (series_id);
