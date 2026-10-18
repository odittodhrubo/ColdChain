/** One minute of readings as sent to the ML service (door / comp = fraction of the minute). */
export interface MinuteRow {
  ts: number; // unix s, start of the minute
  temp: number | null;
  door: number;
  comp: number;
  battery: boolean;
  batt: number;
}

export type Level = 'LOW' | 'MEDIUM' | 'HIGH';

/** The ML service's /predict answer (status ok), or the same shape from the rule-based fallback. */
export interface Prediction {
  status: 'ok';
  at: number;
  pred_temp_30: number | null;
  p10: number | null;
  p90: number | null;
  breach_level: Level;
  breach_prob: number | null;
  minutes_to_breach_estimate: number | null;
  health_score: number | null;
  health_band: string;
  health_method: string;
  health_trend_per_day: number | null;
  weakening: boolean;
  features_used: Record<string, number | null>;
  health_factors: Record<string, number | null>;
  model_version: string | null;
}

export interface StoredPrediction extends Prediction {
  fridge_id: string;
  created_at: number; // unix ms
  source: 'model' | 'fallback';
  stale: boolean; // true when the ML service did not answer: the rule-based fallback was used
}
