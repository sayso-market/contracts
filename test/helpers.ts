export function formatPercentage(percentage: BigInt) {
  return ((Number(percentage) / 1e18) * 100).toFixed(2) + "%";
}
