/**
 * Message safety heuristics — a deliberately small, transparent stand-in for
 * Tinder's "Are You Sure?" (nudges the sender) and "Does This Bother You?"
 * (asks the recipient) features.
 *
 * This is a keyword/shape heuristic, not a classifier. It is intentionally
 * conservative: the cost of a false positive is an unnecessary "are you sure?"
 * prompt, so patterns here are limited to unambiguous cases. Nothing is
 * blocked — the user always decides.
 */

/** Unambiguous abuse. Word-boundary matched so "assess" never trips "ass". */
const HARASSMENT = [
  'fuck you', 'fuck off', 'stfu', 'shut up bitch',
  'bitch', 'whore', 'slut', 'cunt', 'retard', 'faggot',
  'kill yourself', 'kys', 'go die', 'you are ugly', "you're ugly",
  'worthless', 'pathetic loser'
];

/** Sexual pressure — the most reported category on dating apps. */
const EXPLICIT_PRESSURE = [
  'send nudes', 'send nude', 'send pics of your', 'send me nudes',
  'wanna fuck', 'want to fuck', 'dtf', 'netflix and chill tonight',
  'show me your body', 'take it off'
];

/** Classic scam / off-platform money asks. */
const SCAM = [
  'send money', 'western union', 'gift card', 'bitcoin', 'crypto investment',
  'investment opportunity', 'my account is frozen', 'wire transfer',
  'help me pay', 'itunes card', 'cashapp me', 'sugar daddy', 'sugar baby'
];

/** Requests to leave the app early, where protections do not apply. */
const OFF_PLATFORM = [
  'whatsapp me', 'my whatsapp', 'text me at', 'add me on telegram',
  'my snap is', 'hit me up at'
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const build = (list) => new RegExp(`(?:^|\\W)(?:${list.map(escape).join('|')})(?:\\W|$)`, 'i');

const PATTERNS = [
  { category: 'harassment', re: build(HARASSMENT), severity: 'high' },
  { category: 'explicit', re: build(EXPLICIT_PRESSURE), severity: 'high' },
  { category: 'scam', re: build(SCAM), severity: 'medium' },
  { category: 'off_platform', re: build(OFF_PLATFORM), severity: 'low' }
];

const COPY = {
  harassment: {
    sender: 'This message might come across as hurtful. Send it anyway?',
    recipient: 'Does this message bother you?'
  },
  explicit: {
    sender: 'Messages like this are a common reason people get reported. Send it anyway?',
    recipient: 'Does this message bother you?'
  },
  scam: {
    sender: 'Talking about money early on looks like a scam to most people. Send it anyway?',
    recipient: 'This message mentions money. Be careful — never send money to someone you have not met.'
  },
  off_platform: {
    sender: null,
    recipient: 'This message asks you to move to another app. Chats here disappear in 24 hours; other apps do not.'
  }
};

/**
 * Inspect a message body.
 * @returns {{flagged: boolean, category?: string, severity?: string,
 *            senderPrompt?: string|null, recipientPrompt?: string|null}}
 */
export function inspectMessage(body) {
  if (typeof body !== 'string' || !body.trim()) return { flagged: false };

  // Collapse letter-spacing and repeats used to dodge filters ("f u c k", "fuuuck").
  const normalized = body
    .toLowerCase()
    .replace(/[^\w\s]|_/g, ' ')
    .replace(/\b(\w)(?:\s(\w)){2,}\b/g, (m) => m.replace(/\s/g, ''))
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();

  for (const { category, re, severity } of PATTERNS) {
    if (re.test(normalized) || re.test(body)) {
      return {
        flagged: true,
        category,
        severity,
        senderPrompt: COPY[category].sender,
        recipientPrompt: COPY[category].recipient
      };
    }
  }
  return { flagged: false };
}

/** Should the recipient's client show the "does this bother you?" bar? */
export function shouldWarnRecipient(result) {
  return Boolean(result.flagged && result.recipientPrompt);
}
