// Score bands of the risk log (spec F6): low 1-4, medium 5-9, high 10-14, critical 15-25.
export function riskBand(score) {
  if (score <= 4) return "low";
  if (score <= 9) return "medium";
  if (score <= 14) return "high";
  return "critical";
}
