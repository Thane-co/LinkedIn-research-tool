// Temporary tab: published-rate cost estimates for the Apify-vs-AssemblyAI comparison. Not a live
// billing feed — recheck against apify.com and assemblyai.com/pricing before quoting a number.
export const RATES = {
  apifyPostScraperPerPost: 0.0027, // apify/instagram-post-scraper, cheapest published tier
  apifyTranscriptActorPerPost: 0.005, // crawlerbros/instagram-transcript-scraper, $5 / 1,000 results
  assemblyAiSttPerHour: 0.15, // Universal-2 async transcription
  assemblyAiSentimentPerHour: 0.02, // sentiment_analysis add-on
}

// Discovery (finding the posts) runs once and feeds both panels, so its cost is shown once,
// separate from either panel's transcription cost.
export function discoveryCost(postCount: number): number {
  return postCount * RATES.apifyPostScraperPerPost
}

export function beforeTranscriptionCost(postCount: number): number {
  return postCount * RATES.apifyTranscriptActorPerPost
}

export function afterTranscriptionCost(totalAudioSeconds: number): number {
  const hours = totalAudioSeconds / 3600
  return hours * (RATES.assemblyAiSttPerHour + RATES.assemblyAiSentimentPerHour)
}

export function formatUsd(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(3)}`
}

export function formatMs(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}m ${rem.toFixed(0)}s`
}
