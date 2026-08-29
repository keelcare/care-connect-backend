export type SupportPriority = "low" | "medium" | "high" | "critical";

/**
 * Patterns associated with critical emergencies, physical safety threats,
 * severe medical emergencies, violence, crimes, child disappearance, and ban/account compromises.
 */
const CRITICAL_PATTERNS: RegExp[] = [
  // Physical safety & emergencies
  /\b(emergency|sos|life[\s-]threatening|danger|dangerous|unsafe|threat|threats|threaten|threatened|threatening)\b/i,
  // Medical & Injury
  /\b(ambulance|hospital|emergency[\s-]room|paramedic|paramedics|bleeding|bleed|unconscious|fainted|seizure|seizures|convulsion|convulsions|choking|choke|suffocate|suffocating|burn|burns|fracture|broken[\s-]bone|concussion)\b/i,
  /\b(accident|injured|injury|injuries|fell[\s-]down|fall[\s-]down)\b/i,
  /\b(hurt|hit|harmed|injured|slapped|beaten)\s+(my\s+)?(child|baby|kid|toddler|son|daughter|infant)\b/i,
  /\b(child|baby|kid|toddler|son|daughter|infant)\s+(is\s+)?(hurt|hit|injured|bleeding|unconscious|choking)\b/i,
  // Abuse, violence, crime, theft, weapons
  /\b(abuse|abused|abusive|assault|assaulted|violence|violent|physical[\s-]abuse|domestic[\s-]violence|beat|beating|slap|slapped|punch|punched|strangle|strangled)\b/i,
  /\b(police|cops?|fir\b|crime|illegal|theft|thief|stole|stolen|stealing|robbery|robbed|burglar|burglary|break[\s-]in)\b/i,
  /\b(weapon|weapons|knife|knives|gun|guns|firearm)\b/i,
  /\b(poison|poisoned|poisoning|toxic|overdose)\b/i,
  // Child disappearance & safety
  /\b(kidnap|kidnapped|kidnapping|abduct|abducted|missing[\s-]child|lost[\s-]child|child[\s-]missing|child[\s-]lost|baby[\s-]missing|baby[\s-]lost)\b/i,
  // Intoxication on duty
  /\b(drunk|intoxicated|alcohol|drugs|substance[\s-]abuse|narcotics)\b/i,
  // Sexual harassment & misconduct
  /\b(harass|harassed|harassment|molest|molested|molestation|sexual|inappropriate[\s-]touch|inappropriate[\s-]touching|misconduct)\b/i,
  // Account security & bans
  /\b(banned|ban[\s-]appeal|account[\s-]suspended|account[\s-]blocked|hacked|account[\s-]hacked|unauthorized[\s-]access|account[\s-]stolen|account[\s-]compromised)\b/i,
];

/**
 * Patterns associated with high-priority issues:
 * Caregiver absence/no-show on scheduled/in-progress bookings, child left unattended,
 * urgent operational escalations, serious payment fraud/double billing, serious grievances.
 */
const HIGH_PATTERNS: RegExp[] = [
  // Caregiver attendance & no-show
  /\bwhere\s+is\s+(my|the)\s+(nanny|caregiver|sitter|educator|teacher)\b/i,
  /\b(hasn't|has\s+not|haven't|have\s+not|didn't|did\s+not|never)\s+(arrived|showed\s+up|shown\s+up|turned\s+up|come)\b/i,
  /\b(no[\s-]show|not\s+showing\s+up|not\s+showed\s+up|did\s+not\s+arrive|didn't\s+arrive)\b/i,
  /\b(unreachable|not\s+answering|not\s+picking\s+up|phone\s+(is\s+)?switched\s+off|cannot\s+reach|unable\s+to\s+reach|can't\s+reach)\b/i,
  /\b(left\s+alone|unattended|child\s+alone|baby\s+alone|left\s+my\s+child|left\s+early|walked\s+out|abandoned)\b/i,
  /\b(stranded|running\s+very\s+late|hours?\s+late)\b/i,
  // Last minute cancellation
  /\b(cancelled|canceled)\s+(last[\s-]minute|at\s+the\s+last\s+minute)\b/i,
  /\blast[\s-]minute\s+(cancellation|cancel)\b/i,
  // Urgency
  /\b(urgent|urgently|asap|immediate|immediately|right\s+now|escalate|escalation|time[\s-]sensitive)\b/i,
  // Financial dispute / duplicate charge / unauthorized deduction
  /\b(charged\s+twice|double\s+charged|double\s+charge|double\s+payment|duplicate\s+charge|duplicate\s+payment|overcharged|wrong\s+amount)\b/i,
  /\b(unauthorized\s+charge|unauthorized\s+transaction|unauthorized\s+deduction|money\s+deducted|debited\s+twice|deducted\s+twice)\b/i,
  /\b(debited\s+but|deducted\s+but|payment\s+deducted\s+but|refund\s+not\s+received|refund\s+stuck|refund\s+pending|money\s+not\s+received)\b/i,
  /\b(fraud|scam|cheated|cheat)\b/i,
  // Grievance / serious conduct
  /\b(rude|unprofessional|screaming|yelling|screamed|yelled|shouted|shouting|arguing|unacceptable|horrible|terrible|disrespectful|sleeping\s+on\s+duty|ignoring\s+(the\s+)?(baby|child|kid)|misbehavior|misbehaviour)\b/i,
];

/**
 * Patterns associated with low-priority items:
 * General FAQs, feedback, suggestions, compliments.
 */
const LOW_PATTERNS: RegExp[] = [
  /\b(feedback|suggestion|suggestions|feature\s+request|idea|recommendation)\b/i,
  /\b(compliment|appreciation|thank\s+you|thanks|kudos|great\s+service|great\s+job|great\s+experience|appreciate)\b/i,
  /\b(faq|how\s+does\s+it\s+work|how\s+do\s+i|how\s+to|just\s+wondering|general\s+query|general\s+question|curious|inquiry\s+about|info\s+about|information\s+about)\b/i,
];

/**
 * Deterministically assigns a priority level to a support ticket based on keywords
 * present in the subject and description, as well as the category.
 *
 * Priority order evaluated:
 * 1. Critical safety / emergency / crime / account ban keywords -> 'critical'
 * 2. High urgency / no-show / attendance breakdown / payment fraud / grievance category / severe conduct -> 'high'
 * 3. Low priority general queries / feedback / thank you notes -> 'low'
 * 4. Default baseline -> 'medium'
 */
export function classifyTicketPriority(
  subject?: string | null,
  description?: string | null,
  category?: string | null,
): SupportPriority {
  const combinedText = `${subject || ""} ${description || ""}`.toLowerCase();
  const normalizedCategory = (category || "").toLowerCase().trim();

  // 1. Critical checks (highest precedence)
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(combinedText)) {
      return "critical";
    }
  }

  // 2. High checks
  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(combinedText)) {
      return "high";
    }
  }

  // Grievance category defaults to high priority if not already critical
  if (normalizedCategory === "grievance") {
    return "high";
  }

  // 3. Low checks (only if no higher urgency signals matched)
  for (const pattern of LOW_PATTERNS) {
    if (pattern.test(combinedText)) {
      return "low";
    }
  }

  // 4. Default fallback priority
  return "medium";
}
