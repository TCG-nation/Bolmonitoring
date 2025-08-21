export function withJitter(ms, jitterSeconds) {
  const jitter = Math.floor(Math.random() * jitterSeconds * 1000);
  return ms + jitter;
}
