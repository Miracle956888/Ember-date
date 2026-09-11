import { z } from 'zod';
import { badRequest } from './errors.js';

/** Strip control characters and trim. Applied to every free-text field. */
export const sanitizeText = (value) =>
  typeof value === 'string'
    // eslint-disable-next-line no-control-regex
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
    : value;

const trimmed = (schema) => z.preprocess(sanitizeText, schema);

/** Handles that would collide with a route or impersonate the product. */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'ember', 'support', 'help', 'root', 'system',
  'api', 'app', 'login', 'logout', 'register', 'matches', 'chat', 'call',
  'profile', 'settings', 'me', 'you', 'null', 'undefined', 'moderator'
]);

export const emailSchema = trimmed(
  z.string().min(3).max(190).email('Enter a valid email address.').transform((v) => v.toLowerCase())
);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must include at least one letter and one number.');

/**
 * Public handle used for search. Lower-cased slug: letters, digits, underscore
 * and dot, must start with a letter/digit and cannot end with a separator.
 */
export const usernameSchema = trimmed(
  z
    .string()
    .min(3, 'Username must be at least 3 characters.')
    .max(30, 'Username must be at most 30 characters.')
    .transform((v) => v.toLowerCase())
    .refine((v) => /^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/.test(v),
      'Use letters, numbers, dots and underscores only.')
    .refine((v) => !/[._]{2,}/.test(v), 'Dots and underscores cannot repeat.')
    .refine((v) => !RESERVED_USERNAMES.has(v), 'That username is not available.')
);

/** Free-text search term for the username lookup. */
export const usernameQuerySchema = z.object({
  q: trimmed(z.string().min(2, 'Type at least 2 characters.').max(30)).transform((v) => v.toLowerCase()),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});

export const displayNameSchema = trimmed(
  z.string().min(2, 'Name must be at least 2 characters.').max(60, 'Name must be at most 60 characters.')
);

export const isoDateSchema = trimmed(
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'That date is not valid.')
    .refine((v) => {
      const age = (Date.now() - Date.parse(v)) / (365.25 * 24 * 3600 * 1000);
      return age >= 18 && age <= 120;
    }, 'You must be at least 18 years old.')
);

export const genderSchema = z.enum(['male', 'female', 'other']);
export const interestedInSchema = z.enum(['male', 'female', 'everyone']);
export const bioSchema = trimmed(z.string().max(500, 'Bio must be at most 500 characters.'));
export const citySchema = trimmed(z.string().max(80, 'City must be at most 80 characters.'));

export const idParamSchema = z.coerce.bigint().positive();

/** Positive integer id coming from params/body, returned as a JS number. */
export const numericIdSchema = z
  .union([z.number(), z.string()])
  .transform((v) => Number(v))
  .refine((v) => Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER, 'Invalid id.');

export const uuidSchema = z.string().uuid('Invalid client uuid.');

// ---------------------------------------------------------------- schemas

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  birthdate: isoDateSchema.optional().nullable(),
  gender: genderSchema.optional().nullable(),
  interestedIn: interestedInSchema.optional().default('everyone'),
  bio: bioSchema.optional().nullable(),
  city: citySchema.optional().nullable()
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(128)
});

/** Short free-text tags. Used for both languages and hobbies. */
const tagList = (max, label) =>
  z
    .array(trimmed(z.string().min(1).max(40)))
    .max(max, `Add at most ${max} ${label}.`)
    .transform((list) => [...new Set(list.filter(Boolean))]);

export const languagesSchema = tagList(8, 'languages');
export const hobbiesSchema = tagList(10, 'hobbies');

/** ISO 3166-1 alpha-2, upper-cased. */
export const countrySchema = trimmed(
  z.string().length(2, 'Use a two-letter country code.').transform((v) => v.toUpperCase())
);

/**
 * IANA timezone name, validated against the runtime's own tz database rather
 * than a hard-coded list -- no region is privileged and new zones need no code
 * change. Purely a rendering hint: storage and comparison are always UTC.
 */
export const timezoneSchema = trimmed(
  z.string().max(64).refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA timezone name, for example Africa/Lagos or America/Sao_Paulo.')
);

/** BCP-47 language tag, canonicalised ('pt-br' -> 'pt-BR'). */
export const localeSchema = trimmed(
  z.string().max(10).transform((v, ctx) => {
    try {
      return Intl.getCanonicalLocales(v)[0];
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a valid language tag, for example en-GB.' });
      return z.NEVER;
    }
  })
);

export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
    birthdate: isoDateSchema.optional().nullable(),
    gender: genderSchema.optional().nullable(),
    interestedIn: interestedInSchema.optional(),
    bio: bioSchema.optional().nullable(),
    city: citySchema.optional().nullable(),
    avatarUrl: trimmed(z.string().max(255)).optional().nullable(),
    intent: z.enum(['long_term', 'short_term', 'friends', 'figuring_out']).optional().nullable(),
    jobTitle: trimmed(z.string().max(80)).optional().nullable(),
    school: trimmed(z.string().max(80)).optional().nullable(),
    heightCm: z.coerce.number().int().min(120).max(250).optional().nullable(),
    languages: languagesSchema.optional(),
    hobbies: hobbiesSchema.optional(),
    country: countrySchema.optional().nullable(),
    timezone: timezoneSchema.optional().nullable(),
    locale: localeSchema.optional().nullable()
  })
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update.');

export const swipeSchema = z.object({
  swipeeId: numericIdSchema,
  direction: z.enum(['like', 'pass', 'superlike'])
});

export const sendMessageSchema = z
  .object({
    body: trimmed(z.string().max(4000, 'Message is too long.')).optional().nullable(),
    clientUuid: uuidSchema.optional().nullable(),
    attachmentId: numericIdSchema.optional().nullable(),
    // An E2EE message sends `envelope` INSTEAD of `body`. Declared inline
    // rather than referencing envelopeSchema, which is defined further down
    // this file: a forward reference here would be a TDZ error at import time.
    envelope: z
      .object({
        // Must be base64: junk here is unreadable to the recipient forever,
        // so we reject it at the door rather than storing an undecryptable row.
        ciphertext: z
          .string()
          .trim()
          .max(16_384)
          .regex(/^[A-Za-z0-9+/=_-]+$/, 'Ciphertext must be base64.'),
        iv: z
          .string()
          .trim()
          .max(32)
          .regex(/^[A-Za-z0-9+/=_-]+$/, 'IV must be base64.'),
        keyId: z.string().trim().max(64).optional().nullable()
      })
      .optional()
      .nullable()
  })
  .refine(
    (o) => (o.body && o.body.length > 0) || o.attachmentId || o.envelope,
    'Write something or attach a file.'
  );

export const deckQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(10)
});

export const messagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const blockSchema = z.object({ blockedId: numericIdSchema });

export const reportSchema = z.object({
  reportedId: numericIdSchema,
  reason: trimmed(z.string().min(3, 'Tell us briefly what happened.').max(255))
});

export const photoOrderSchema = z.object({
  order: z.array(numericIdSchema).min(1).max(6)
});

// ------------------------------------------------- discovery & location

export const intentSchema = z.enum(['long_term', 'short_term', 'friends', 'figuring_out']);
export const locationModeSchema = z.enum(['precise', 'approximate', 'hidden']);

const latSchema = z.coerce.number().min(-90, 'Invalid latitude.').max(90, 'Invalid latitude.');
const lngSchema = z.coerce.number().min(-180, 'Invalid longitude.').max(180, 'Invalid longitude.');

export const locationUpdateSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  accuracy: z.coerce.number().min(0).max(100000).optional().nullable(),
  city: citySchema.optional().nullable()
});

export const nearbyQuerySchema = z.object({
  radiusKm: z.coerce.number().int().min(1).max(500).default(50),
  limit: z.coerce.number().int().min(1).max(60).default(30),
  // Keyset cursor: the (distance, id) of the last row seen. Sent as two flat
  // query params so the URL stays readable and no JSON is parsed from input.
  cursorDistanceKm: z.coerce.number().min(0).max(20037).optional(),
  cursorId: z.coerce.number().int().min(1).optional(),
  onlineOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional()
    .default(false)
});

export const bumpedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(30),
  days: z.coerce.number().int().min(1).max(30).default(7)
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(30)
});

const boolish = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === 'true' || v === '1');

export const settingsSchema = z
  .object({
    minAge: z.coerce.number().int().min(18).max(99).optional(),
    maxAge: z.coerce.number().int().min(18).max(99).optional(),
    maxDistanceKm: z.coerce.number().int().min(1).max(500).optional(),
    verifiedOnly: boolish.optional(),
    onlineOnly: boolish.optional(),
    showMeGlobally: boolish.optional(),
    incognito: boolish.optional(),
    locationMode: locationModeSchema.optional(),
    showDistance: boolish.optional(),
    showOnline: boolish.optional(),
    allowBumpedInto: boolish.optional()
  })
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update.');

export const passportSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  label: trimmed(z.string().min(1).max(80))
});

export const interestsSchema = z.object({
  slugs: z.array(trimmed(z.string().min(1).max(40))).max(8, 'Pick at most 8 interests.')
});

export const promptsSchema = z.object({
  prompts: z
    .array(
      z.object({
        key: trimmed(z.string().min(1).max(40)),
        answer: trimmed(z.string().min(1, 'Write an answer.').max(200, 'Keep it under 200 characters.'))
      })
    )
    .max(3, 'You can answer at most 3 prompts.')
});

export const tapSchema = z.object({
  targetId: numericIdSchema,
  kind: z.enum(['wave', 'crush', 'fire']).default('wave')
});

export const favoriteSchema = z.object({ targetId: numericIdSchema });

export const verificationSchema = z.object({
  gesture: trimmed(z.string().min(1).max(40))
});

export const shareLocationSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  accuracy: z.coerce.number().min(0).max(100000).optional().nullable(),
  label: trimmed(z.string().max(120)).optional().nullable(),
  liveMinutes: z.coerce.number().int().min(0).max(60).optional().default(0),
  clientUuid: uuidSchema.optional().nullable()
});

export const liveLocationSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  accuracy: z.coerce.number().min(0).max(100000).optional().nullable()
});

// ---------------------------------------------------------------- helpers

/** Parse `data` with `schema`, throwing a 400 AppError carrying field errors. */
export function parseOrThrow(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!details[key]) details[key] = issue.message;
    }
    const first = result.error.issues[0];
    throw badRequest(first?.message || 'Invalid request.', { code: 'VALIDATION_ERROR', details });
  }
  return result.data;
}

/** Express middleware factory: validates req[source] and replaces it. */
export function validate(schema, source = 'body') {
  return function validateMiddleware(req, _res, next) {
    try {
      req[source] = parseOrThrow(schema, req[source]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// --------------------------------------------------------- password recovery

export const forgotPasswordSchema = z.object({
  email: emailSchema
});

export const resetPasswordSchema = z.object({
  token: trimmed(z.string().min(32, 'That reset link is invalid.').max(128)),
  password: passwordSchema
});

/* ------------------------------------------------------------------ *
 * V1 identity: username changes, email/phone verification, profile depth
 * ------------------------------------------------------------------ */

export const changeUsernameSchema = z.object({ username: usernameSchema });

/**
 * E.164-ish. Deliberately permissive about national formatting so the app is
 * not Nigeria-only: we require a leading + and 8-15 digits, nothing more.
 */
export const phoneSchema = trimmed(
  z
    .string()
    .min(8, 'Enter your phone number.')
    .max(20)
    .transform((v) => v.replace(/[\s()\-.]/g, ''))
    .refine((v) => /^\+[1-9]\d{7,14}$/.test(v),
      'Use the international format, for example +2348012345678.')
);

export const startVerificationSchema = z.object({
  kind: z.enum(['email', 'phone'], { errorMap: () => ({ message: 'Choose email or phone.' }) }),
  phone: phoneSchema.optional()
});

export const confirmVerificationSchema = z.object({
  kind: z.enum(['email', 'phone'], { errorMap: () => ({ message: 'Choose email or phone.' }) }),
  code: trimmed(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'))
});

/* ------------------------------------------------------------------ *
 * Likes (Phase 4)
 * ------------------------------------------------------------------ */

/** Mirrors the ENUM in `content_likes` and LIKE_TARGETS in like.service. */
export const likeTargetTypeSchema = z.enum(['profile', 'photo', 'post', 'moment', 'comment'], {
  errorMap: () => ({ message: 'Unknown like target.' })
});

export const likeBodySchema = z.object({
  targetType: likeTargetTypeSchema,
  targetId: numericIdSchema
});

export const likeTargetSchema = z.object({
  targetType: likeTargetTypeSchema,
  targetId: numericIdSchema
});

/* ------------------------------------------------------------------ *
 * E2EE device + conversation keys, and the disappearing-message timer
 * ------------------------------------------------------------------ */

/** A device id is a client-generated UUID stored in IndexedDB. */
export const deviceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9-]{8,36}$/, 'That device id is not valid.');

/** Base64 payloads: bounded so nobody can park megabytes in the key tables. */
const base64Schema = (max, label) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long.`)
    .regex(/^[A-Za-z0-9+/=_-]+$/, `${label} must be base64.`);

export const registerDeviceSchema = z.object({
  deviceId: deviceIdSchema,
  publicKey: base64Schema(255, 'Public key'),
  algorithm: z.enum(['ECDH-P256', 'X25519']).default('ECDH-P256'),
  label: trimmed(z.string().max(80)).optional().nullable()
});

const wrappedKeySchema = z.object({
  userId: numericIdSchema,
  deviceId: deviceIdSchema,
  wrappedKey: base64Schema(1024, 'Wrapped key'),
  iv: base64Schema(32, 'IV'),
  senderPubKey: base64Schema(255, 'Sender public key')
});

export const publishKeysSchema = z.object({
  keyId: z.string().trim().regex(/^[a-zA-Z0-9-]{8,64}$/, 'That key id is not valid.'),
  // 2 users x 10 devices is the ceiling, so 20 wraps covers the worst case.
  wraps: z.array(wrappedKeySchema).min(1).max(20)
});

/**
 * The disappearing-message timer. An enum, not a free number: an arbitrary
 * value would let someone turn an ephemeral thread into a permanent archive.
 */
export const setTimerSchema = z.object({
  ttlHours: z.coerce.number().int().refine((h) => [1, 6, 12, 24, 72, 168].includes(h), {
    message: 'Choose one of the offered timers: 1h, 6h, 12h, 24h, 3 days or 7 days.'
  })
});

/** An E2EE envelope replaces the plaintext body on the wire. */
export const envelopeSchema = z.object({
  ciphertext: base64Schema(16_384, 'Ciphertext'),
  iv: base64Schema(32, 'IV'),
  keyId: z.string().trim().max(64).optional().nullable()
});

/* ------------------------------------------------------------------ *
 * Phase 6 — social layer (moments, posts, polls, comments)
 *
 * Every closed set below is duplicated from its service on purpose. Importing
 * the service here would create a cycle (service -> validators -> service) and
 * has already caused a TDZ crash once in this codebase, so the enums are
 * restated and the services own the runtime check as well.
 * ------------------------------------------------------------------ */

/** A media handle produced by POST /api/uploads/social. */
export const socialMediaSchema = z.object({
  kind: z.enum(['photo', 'video']),
  url: z.string().max(255),
  thumbUrl: z.string().max(255).optional().nullable(),
  fileKey: z.string().max(255),
  thumbKey: z.string().max(255).optional().nullable()
});

export const createMomentSchema = z
  .object({
    kind: z.enum(['photo', 'video', 'text'], { errorMap: () => ({ message: 'Choose a photo, video or text moment.' }) }),
    body: trimmed(z.string().max(500, 'Keep it under 500 characters.')).optional().nullable(),
    background: z.enum(['ember', 'dusk', 'ocean', 'forest', 'mono']).optional().nullable(),
    media: socialMediaSchema.optional().nullable()
  })
  .refine((v) => v.kind === 'text' || v.media, { message: 'Attach a photo or video.', path: ['media'] })
  .refine((v) => v.kind !== 'text' || (v.body && v.body.length > 0), {
    message: 'Write something for your moment.',
    path: ['body']
  });

export const momentReactionSchema = z.object({
  emoji: z.enum(['❤️', '🔥', '😂', '😮', '😍', '👏'], {
    errorMap: () => ({ message: 'Choose one of the offered reactions.' })
  })
});

export const momentReplySchema = z.object({
  body: trimmed(z.string().min(1, 'Write a reply first.').max(2000, 'That reply is too long.'))
});

export const createPostSchema = z
  .object({
    body: trimmed(z.string().max(1000, 'Keep it under 1000 characters.')).optional().nullable(),
    media: z.array(socialMediaSchema).max(4, 'Up to 4 photos or videos.').optional().default([]),
    poll: z
      .object({
        options: z
          .array(trimmed(z.string().min(1).max(80)))
          .min(2, 'A poll needs at least two options.')
          .max(4, 'A poll can have up to 4 options.')
      })
      .optional()
      .nullable()
  })
  .refine((v) => (v.body && v.body.length) || (v.media && v.media.length), {
    message: 'Write something or add a photo.',
    path: ['body']
  });

export const pollVoteSchema = z.object({ optionId: numericIdSchema });

export const createCommentSchema = z.object({
  body: trimmed(z.string().min(1, 'Write something first.').max(500, 'Keep comments under 500 characters.')),
  parentId: numericIdSchema.optional().nullable()
});

/** Cursor pagination shared by the post feed. */
export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.coerce.number().int().positive().optional().nullable()
});

/** The full V1 report taxonomy, usable against every content surface. */
export const contentReportSchema = z.object({
  targetType: z.enum(['profile', 'message', 'photo', 'post', 'moment', 'comment']),
  targetId: numericIdSchema,
  reason: z.enum(
    ['scam', 'fake', 'impersonation', 'harassment', 'spam', 'threats', 'inappropriate', 'ncii', 'other'],
    { errorMap: () => ({ message: 'Choose a reason for the report.' }) }
  ),
  details: trimmed(z.string().max(1000)).optional().nullable()
});
