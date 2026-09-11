/**
 * u-page.js — the shareable public profile at /@username.
 *
 * Works signed out (that is the point of a share link), so it does not use
 * bootPage: it asks who you are, then renders the same profile either way and
 * only offers actions when there is a session.
 */
import { initThemeToggle } from '/js/theme.js';
import { api, ApiError } from '/js/api.js';
import { $, escapeHtml, avatarSrc, attachAvatarFallback, toast, timeAgo } from '/js/ui.js';
import { verifiedBadge, intentLabel, reasonList } from '/js/people.js';
import { likeButton, wireLikes } from '/js/likes-ui.js';

initThemeToggle();

const state = $('#profile-state');
const handle = decodeURIComponent(location.pathname.replace(/^\/@/, '')).trim();

/** Signed-out visitors still get the profile; they just cannot act on it. */
async function whoAmI() {
  try {
    const data = await api.me();
    return data.user || null;
  } catch {
    return null;
  }
}

function notFound() {
  state.innerHTML = `
    <div class="px-6 py-20 text-center">
      <div class="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-surface-grey text-3xl" aria-hidden="true">🔍</div>
      <h1 class="mt-4 text-xl font-extrabold tracking-tight text-ink">No user found</h1>
      <p class="mx-auto mt-1.5 max-w-[36ch] text-[14px] text-ink-soft">
        There is no profile at <span class="font-semibold text-ink">@${escapeHtml(handle)}</span>.
        The username may have changed, or the account may no longer be active.
      </p>
      <a href="/app" class="btn-primary mt-6 inline-flex">Back to Ember</a>
    </div>`;
}

function chip(text) {
  return `<span class="rounded-full bg-brand-50 px-2.5 py-1 text-[12.5px] font-semibold text-brand-700">${escapeHtml(text)}</span>`;
}

function section(title, inner) {
  if (!inner) return '';
  return `
    <section class="border-t border-hairline/[var(--hairline-a)] px-5 py-5">
      <h2 class="mb-2.5 text-[12.5px] font-bold uppercase tracking-wide text-ink-faint">${escapeHtml(title)}</h2>
      ${inner}
    </section>`;
}

function tierRow(tier, icon) {
  return `
    <li class="flex items-center gap-2 text-[13.5px] ${tier.verified ? 'text-ink' : 'text-ink-faint'}">
      <span aria-hidden="true">${tier.verified ? '✓' : '·'}</span>
      <span>${icon} ${escapeHtml(tier.label)}</span>
    </li>`;
}

function render(user, viewer) {
  const isSelf = Boolean(viewer && viewer.id === user.id);
  const online = user.isOnline
    ? '<span class="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><span class="online-dot"></span>Online now</span>'
    : '';

  const facts = [
    user.city && `📍 ${user.city}`,
    user.jobTitle && `💼 ${user.jobTitle}`,
    user.school && `🎓 ${user.school}`,
    user.intent && `💫 ${intentLabel(user.intent)}`
  ].filter(Boolean);

  state.innerHTML = `
    <div class="relative">
      <img data-avatar src="${escapeHtml(avatarSrc(user))}" alt="${escapeHtml(user.displayName)}"
           class="aspect-[4/5] w-full object-cover" />
      <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-5 pt-16">
        <h1 class="flex flex-wrap items-center gap-2 text-2xl font-extrabold tracking-tight text-white">
          ${escapeHtml(user.displayName)}${user.age ? `<span class="font-semibold">${user.age}</span>` : ''}
          ${user.isVerified ? verifiedBadge('h-5 w-5') : ''}
        </h1>
        <p class="mt-0.5 text-[14px] font-semibold text-white/85">@${escapeHtml(user.username)}</p>
      </div>
    </div>

    <div class="flex items-center justify-between gap-3 px-5 py-4">
      ${online || `<span class="text-[13px] text-ink-faint">${user.isOnline ? '' : 'Offline'}</span>`}
      <div class="flex items-center gap-2">
        <button type="button" class="btn-ghost !px-3 !py-2 text-[13px]" data-action="copy-link">Copy link</button>
        ${isSelf
    ? '<a href="/profile" class="btn-primary !px-4 !py-2 text-[13px]">Edit profile</a>'
    : viewer
      ? `${likeButton({
        type: 'profile',
        id: user.id,
        liked: Boolean(user.liked),
        count: Number(user.likeCount) || 0,
        label: `${user.displayName}'s profile`
      })}<button type="button" class="btn-primary !px-4 !py-2 text-[13px]" data-action="swipe-like">💜 Like</button>`
      : '<a href="/register" class="btn-primary !px-4 !py-2 text-[13px]">Join to say hello</a>'}
      </div>
    </div>

    ${facts.length ? `<div class="flex flex-wrap gap-1.5 px-5 pb-4">${facts.map(chip).join('')}</div>` : ''}

    ${!isSelf && user.reasons?.length
    ? `<div class="mx-5 mb-4 rounded-2xl bg-surface-grey px-4 py-3">
         <p class="text-[12.5px] font-semibold text-ink-soft">Why you two</p>
         <div class="mt-1.5">${reasonList(user)}</div>
       </div>`
    : ''}

    ${section('About', user.bio ? `<p class="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink">${escapeHtml(user.bio)}</p>` : '')}

    ${section('Interests', user.interests?.length
    ? `<div class="flex flex-wrap gap-1.5">${user.interests
      .map((i) => chip(`${i.emoji ? `${i.emoji} ` : ''}${i.label}`))
      .join('')}</div>`
    : '')}

    ${section('Languages', user.languages?.length
    ? `<div class="flex flex-wrap gap-1.5">${user.languages.map(chip).join('')}</div>` : '')}

    ${section('Hobbies', user.hobbies?.length
    ? `<div class="flex flex-wrap gap-1.5">${user.hobbies.map(chip).join('')}</div>` : '')}

    ${section('Prompts', user.prompts?.length
    ? user.prompts
      .map(
        (p) => `
          <div class="mb-3 last:mb-0 rounded-2xl bg-surface-grey px-4 py-3">
            <p class="text-[12.5px] font-semibold text-ink-soft">${escapeHtml(p.question)}</p>
            <p class="mt-1 text-[15px] font-semibold text-ink">${escapeHtml(p.answer)}</p>
          </div>`
      )
      .join('')
    : '')}

    ${section('Verification', `
      <ul class="space-y-1.5">
        ${tierRow(user.verification.email, '📧')}
        ${tierRow(user.verification.phone, '📱')}
        ${tierRow(user.verification.photo, '📸')}
      </ul>
      <p class="mt-2 text-[12px] leading-relaxed text-ink-faint">
        Verification confirms an address, a phone line or a live selfie. It is not a safety guarantee —
        always meet new people carefully.
      </p>`)}

    ${user.photos?.length > 1
    ? section('Photos', `<div class="grid grid-cols-3 gap-1.5">${user.photos
      .slice(1)
      .map(
        (p) => `<img src="${escapeHtml(p.url)}" alt="" loading="lazy" decoding="async" class="aspect-square w-full rounded-xl object-cover" />`
      )
      .join('')}</div>`)
    : ''}

    <p class="px-5 pt-5 text-center text-[12px] text-ink-faint">
      ${user.isOnline ? 'Active now' : user.lastSeenAt ? `Last seen ${escapeHtml(timeAgo(user.lastSeenAt))}` : ''}
    </p>`;

  attachAvatarFallback(state.querySelector('[data-avatar]'), user);

  state.querySelector('[data-action="copy-link"]')?.addEventListener('click', async () => {
    const url = `${location.origin}/@${user.username}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Profile link copied');
    } catch {
      toast(url);
    }
  });

  // Content likes (idempotent, no swipe side effects) are delegated.
  wireLikes(state);

  state.querySelector('[data-action="swipe-like"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.swipe(user.id, 'like');
      toast(result.matched ? `It's a match with ${user.displayName}! 💜` : 'Liked');
      button.textContent = result.matched ? '💜 Matched' : '💜 Liked';
    } catch (err) {
      button.disabled = false;
      toast(err instanceof ApiError ? err.message : 'That did not work.', { type: 'error' });
    }
  });
}

const viewer = await whoAmI();
// A signed-out visitor should be sent to the app, not left on a dead link.
if (!viewer) $('[data-back-link]').setAttribute('href', '/login');

try {
  const { user } = await api.userByUsername(handle);
  document.title = `${user.displayName} (@${user.username}) — Ember`;
  render(user, viewer);
} catch (err) {
  if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
  else {
    state.innerHTML =
      '<div class="px-6 py-20 text-center text-[14px] text-ink-soft">We could not load this profile. Try again shortly.</div>';
  }
}
