/**
 * posts.js — the 24-hour post feed that sits under the Moments tray.
 *
 * Posts carry text, up to four photos/videos and an optional poll. Everything
 * expires 24 hours after it is written, and the countdown is shown on every
 * card so the ephemerality is a visible promise rather than fine print.
 *
 * Comments are one level deep on purpose: replies to replies are re-parented
 * by the server, which keeps the thread readable on a phone.
 */
import { api, ApiError } from './api.js';
import { toast, timeAgo, escapeHtml, avatarSrc, attachAvatarFallback, openModal, confirmDialog, el } from './ui.js';
import { reportSheet } from './moments.js';

const $ = (sel, root = document) => root.querySelector(sel);

let posts = [];
let nextCursor = null;
let loading = false;
let exhausted = false;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function countdown(post) {
  const secs = Number(post.secondsLeft || 0);
  if (secs <= 0) return 'Expiring now';
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.round(secs / 60))}m left`;
}

function mediaGrid(media) {
  if (!media?.length) return '';
  const layout =
    media.length === 1
      ? 'grid-cols-1'
      : media.length === 2
        ? 'grid-cols-2'
        : media.length === 3
          ? 'grid-cols-2'
          : 'grid-cols-2';

  return `
    <div class="mt-3 grid ${layout} gap-1.5 overflow-hidden rounded-2xl">
      ${media
        .map((m, i) => {
          const span = media.length === 3 && i === 0 ? 'row-span-2' : '';
          const tall = media.length === 1 ? 'max-h-[420px]' : 'h-40 sm:h-48';
          return m.kind === 'video'
            ? `<video src="${escapeHtml(m.url)}" class="${span} ${tall} w-full bg-black object-cover" controls playsinline preload="metadata"></video>`
            : `<img src="${escapeHtml(m.url)}" alt="" loading="lazy" decoding="async" class="${span} ${tall} w-full bg-surface-grey object-cover" />`;
        })
        .join('')}
    </div>`;
}

function pollBlock(post) {
  const poll = post.poll;
  if (!poll) return '';

  return `
    <div class="mt-3 flex flex-col gap-1.5" data-poll="${post.id}">
      ${poll.options
        .map(
          (o) => `
        <button type="button" data-vote="${o.id}"
                class="relative overflow-hidden rounded-xl border ${
                  o.isMine ? 'border-brand-primary' : 'border-line'
                } px-3 py-2.5 text-left transition-colors hover:border-brand-primary">
          <span class="absolute inset-y-0 left-0 ${o.isMine ? 'bg-brand-50' : 'bg-surface-grey'}"
                style="width:${poll.hasVoted ? o.percent : 0}%" aria-hidden="true"></span>
          <span class="relative flex items-center justify-between gap-3">
            <span class="text-[14px] font-medium text-ink">${escapeHtml(o.label)}${o.isMine ? ' ✓' : ''}</span>
            ${poll.hasVoted ? `<span class="shrink-0 text-[13px] font-semibold text-ink-soft">${o.percent}%</span>` : ''}
          </span>
        </button>`
        )
        .join('')}
      <p class="mt-0.5 text-[12px] text-ink-faint">
        ${poll.totalVotes} vote${poll.totalVotes === 1 ? '' : 's'}${poll.hasVoted ? ' · tap another option to change your vote' : ''}
      </p>
    </div>`;
}

function postCard(post) {
  return `
    <article id="post-${post.id}" class="rounded-3xl bg-surface p-4 shadow-card scroll-mt-24" data-post="${post.id}">
      <header class="flex items-center gap-3">
        <a href="/@${escapeHtml(post.author.username)}" class="shrink-0">
          <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(post.author))}" alt="" class="h-10 w-10 rounded-full object-cover"
               data-author-of="${post.id}" />
        </a>
        <div class="min-w-0 flex-1">
          <a href="/@${escapeHtml(post.author.username)}" class="flex items-center gap-1">
            <span class="truncate text-[14.5px] font-bold text-ink">${escapeHtml(post.author.displayName)}</span>
            ${post.author.isVerified ? '<span class="text-[12px] text-brand-primary" title="Verified">✓</span>' : ''}
          </a>
          <p class="text-[12.5px] text-ink-faint">
            ${escapeHtml(timeAgo(post.createdAt))} · <span class="font-medium text-brand-primary">${countdown(post)}</span>
          </p>
        </div>
        <button type="button" data-menu="${post.id}" class="tile-action" aria-label="Post options">
          <svg viewBox="0 0 24 24" class="h-5 w-5 fill-current" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </header>

      ${post.body ? `<p class="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">${escapeHtml(post.body)}</p>` : ''}
      ${mediaGrid(post.media)}
      ${pollBlock(post)}

      <footer class="mt-3 flex items-center gap-1 border-t border-hairline/[var(--hairline-a)] pt-2">
        <button type="button" data-like="${post.id}" aria-pressed="${post.liked}"
                class="flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold transition-colors ${
                  post.liked ? 'text-brand-primary' : 'text-ink-soft hover:bg-surface-grey'
                }">
          <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] ${post.liked ? 'fill-current' : 'fill-none stroke-current'}" stroke-width="2" aria-hidden="true">
            <path d="M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z"/>
          </svg>
          <span data-like-count="${post.id}">${post.likeCount}</span>
        </button>
        <button type="button" data-comments="${post.id}"
                class="flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold text-ink-soft transition-colors hover:bg-surface-grey">
          <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] fill-none stroke-current" stroke-width="2" aria-hidden="true">
            <path d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z" stroke-linejoin="round"/>
          </svg>
          <span data-comment-count="${post.id}">${post.commentCount}</span>
        </button>
      </footer>

      <div class="hidden" data-thread="${post.id}"></div>
    </article>`;
}

function renderFeed() {
  const list = $('#post-feed');
  if (!posts.length) {
    list.innerHTML = `
      <div class="rounded-3xl bg-surface p-10 text-center shadow-card">
        <div class="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-brand-50 text-3xl" aria-hidden="true">✨</div>
        <h2 class="text-lg font-bold text-ink">Nothing here yet</h2>
        <p class="mx-auto mt-1 max-w-xs text-[14px] leading-relaxed text-ink-soft">
          Posts live for 24 hours. Be the first to start something today.
        </p>
      </div>`;
    return;
  }
  list.innerHTML = posts.map(postCard).join('');
  for (const img of list.querySelectorAll('[data-author-of]')) {
    const post = posts.find((p) => String(p.id) === img.dataset.authorOf);
    attachAvatarFallback(img, post?.author);
  }
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function load({ append = false } = {}) {
  if (loading || (append && exhausted)) return;
  loading = true;
  try {
    const res = await api.postsFeed(append && nextCursor ? { before: nextCursor } : {});
    const batch = res.posts || [];
    posts = append ? posts.concat(batch) : batch;
    nextCursor = res.nextCursor || null;
    exhausted = !res.nextCursor || batch.length === 0;
    renderFeed();
  } catch {
    if (!append) toast('Could not load the feed.', { type: 'error' });
  } finally {
    loading = false;
    $('#feed-sentinel')?.classList.toggle('hidden', exhausted);
  }
}

function findPost(id) {
  return posts.find((p) => String(p.id) === String(id));
}

/* ------------------------------------------------------------------ *
 * Interactions
 * ------------------------------------------------------------------ */

async function toggleLike(id) {
  const post = findPost(id);
  if (!post) return;

  // Optimistic, then reconciled with the server's authoritative count.
  const before = { liked: post.liked, likeCount: post.likeCount };
  post.liked = !post.liked;
  post.likeCount += post.liked ? 1 : -1;
  paintLike(post);

  try {
    const res = await api.likePost(id);
    post.liked = res.liked;
    post.likeCount = res.count;
    paintLike(post);
  } catch (err) {
    Object.assign(post, before);
    paintLike(post);
    toast(err instanceof ApiError ? err.message : 'Could not save that like.', { type: 'error' });
  }
}

function paintLike(post) {
  const btn = $(`[data-like="${post.id}"]`);
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(post.liked));
  btn.classList.toggle('text-brand-primary', post.liked);
  btn.classList.toggle('text-ink-soft', !post.liked);
  const svg = btn.querySelector('svg');
  svg.classList.toggle('fill-current', post.liked);
  svg.classList.toggle('fill-none', !post.liked);
  svg.classList.toggle('stroke-current', !post.liked);
  $(`[data-like-count="${post.id}"]`).textContent = post.likeCount;
}

async function vote(postId, optionId) {
  const post = findPost(postId);
  if (!post?.poll) return;
  try {
    // The endpoint returns the whole refreshed post ({post:{...}}), not a
    // bare poll — read through it or the poll silently disappears.
    const res = await api.votePoll(postId, optionId);
    post.poll = res.post.poll;
    const holder = $(`[data-poll="${postId}"]`);
    if (holder) holder.outerHTML = pollBlock(post);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not record your vote.', { type: 'error' });
  }
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

function commentRow(c, postId) {
  return `
    <div id="comment-${c.id}" class="flex gap-2.5 scroll-mt-24 ${c.parentId ? 'ml-10' : ''}" data-comment="${c.id}">
      <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(c.author))}" alt="" class="h-8 w-8 shrink-0 rounded-full object-cover" />
      <div class="min-w-0 flex-1">
        <div class="rounded-2xl bg-surface-grey px-3 py-2">
          <a href="/@${escapeHtml(c.author.username)}" class="text-[13px] font-bold text-ink">${escapeHtml(c.author.displayName)}</a>
          <p class="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">${escapeHtml(c.body)}</p>
        </div>
        <div class="mt-0.5 flex items-center gap-3 pl-1 text-[12px] text-ink-faint">
          <span>${escapeHtml(timeAgo(c.createdAt))}</span>
          <button type="button" data-clike="${c.id}" class="font-semibold ${c.liked ? 'text-brand-primary' : 'hover:text-ink'}">
            Like${c.likeCount ? ` (${c.likeCount})` : ''}
          </button>
          ${!c.parentId ? `<button type="button" data-creply="${c.id}" data-post="${postId}" class="font-semibold hover:text-ink">Reply</button>` : ''}
          ${
            c.isOwn || findPost(postId)?.isOwn
              ? `<button type="button" data-cdelete="${c.id}" class="font-semibold hover:text-nope">Delete</button>`
              : `<button type="button" data-creport="${c.id}" class="font-semibold hover:text-nope">Report</button>`
          }
        </div>
        ${(c.replies || []).map((r) => commentRow(r, postId)).join('')}
      </div>
    </div>`;
}

async function openThread(postId) {
  const holder = $(`[data-thread="${postId}"]`);
  if (!holder) return;

  if (!holder.classList.contains('hidden')) {
    holder.classList.add('hidden');
    return;
  }
  holder.classList.remove('hidden');
  holder.innerHTML = '<p class="py-3 text-center text-[13px] text-ink-faint">Loading…</p>';

  try {
    const { comments, total } = await api.comments(postId);
    const post = findPost(postId);
    if (post) post.commentCount = total;
    const countEl = $(`[data-comment-count="${postId}"]`);
    if (countEl) countEl.textContent = total;

    holder.innerHTML = `
      <div class="mt-3 flex flex-col gap-3 border-t border-hairline/[var(--hairline-a)] pt-3">
        ${comments.length ? comments.map((c) => commentRow(c, postId)).join('') : '<p class="text-[13.5px] text-ink-faint">No comments yet. Say something kind.</p>'}
        <form class="flex items-center gap-2" data-cform="${postId}">
          <input type="text" class="field flex-1" maxlength="500" placeholder="Write a comment…"
                 aria-label="Write a comment" data-cinput="${postId}" />
          <button type="submit" class="btn-primary !px-4 !py-2 text-[13.5px]">Send</button>
        </form>
      </div>`;
  } catch {
    holder.innerHTML = '<p class="py-3 text-center text-[13px] text-nope">Could not load comments.</p>';
  }
}

async function submitComment(postId, body, parentId = null) {
  if (!body.trim()) return;
  try {
    await api.addComment(postId, body.trim(), parentId);
    const holder = $(`[data-thread="${postId}"]`);
    holder.classList.add('hidden'); // force a reload of the thread
    await openThread(postId);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not post that comment.', { type: 'error' });
  }
}

function replyPrompt(commentId, postId) {
  const input = el('input', { type: 'text', class: 'field', maxlength: 500, placeholder: 'Your reply…' });
  openModal({
    title: 'Reply',
    body: el('div', { class: 'text-left' }, [el('label', { class: 'label', text: 'Your reply' }), input]),
    actions: [
      { label: 'Cancel', value: null, class: 'btn-secondary' },
      {
        label: 'Reply',
        value: 'sent',
        class: 'btn-primary',
        onClick: async () => {
          if (!input.value.trim()) return false;
          await submitComment(postId, input.value, Number(commentId));
        }
      }
    ]
  });
  setTimeout(() => input.focus(), 60);
}

/* ------------------------------------------------------------------ *
 * Composer + menu
 * ------------------------------------------------------------------ */

function composer() {
  const wrap = el('div', { class: 'text-left' });
  wrap.innerHTML = `
    <div class="flex flex-col gap-3">
      <div>
        <label class="label" for="post-body">Say something</label>
        <textarea id="post-body" class="field min-h-[104px] resize-y" rows="3" maxlength="1000"
                  placeholder="What is on your mind today?"></textarea>
      </div>
      <div>
        <label class="label" for="post-files">Photos or videos (up to 4)</label>
        <input id="post-files" type="file" accept="image/*,video/*" multiple class="field" />
      </div>
      <div>
        <button type="button" data-action="toggle-poll" class="btn-secondary !py-2 text-[13.5px]">Add a poll</button>
        <div id="poll-fields" class="mt-2 hidden flex-col gap-2">
          <input type="text" class="field" data-opt="0" maxlength="80" placeholder="Option 1" />
          <input type="text" class="field" data-opt="1" maxlength="80" placeholder="Option 2" />
          <input type="text" class="field" data-opt="2" maxlength="80" placeholder="Option 3 (optional)" />
          <input type="text" class="field" data-opt="3" maxlength="80" placeholder="Option 4 (optional)" />
        </div>
      </div>
      <p class="text-[12.5px] leading-relaxed text-ink-faint">
        Your post and everything on it disappears after 24 hours.
      </p>
    </div>`;

  let pollOn = false;
  wrap.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="toggle-poll"]')) return;
    pollOn = !pollOn;
    const fields = wrap.querySelector('#poll-fields');
    fields.classList.toggle('hidden', !pollOn);
    fields.classList.toggle('flex', pollOn);
    e.target.closest('button').textContent = pollOn ? 'Remove poll' : 'Add a poll';
  });

  openModal({
    title: 'New post',
    body: wrap,
    actions: [
      { label: 'Cancel', value: null, class: 'btn-secondary' },
      {
        label: 'Post',
        value: 'posted',
        class: 'btn-primary',
        onClick: async () => {
          const body = wrap.querySelector('#post-body').value.trim();
          const files = [...(wrap.querySelector('#post-files').files || [])].slice(0, 4);

          let poll = null;
          if (pollOn) {
            const options = [...wrap.querySelectorAll('[data-opt]')].map((i) => i.value.trim()).filter(Boolean);
            if (options.length < 2) {
              toast('A poll needs at least two options.', { type: 'error' });
              return false;
            }
            poll = { options };
          }
          if (!body && !files.length) {
            toast('Write something or add a photo.', { type: 'error' });
            return false;
          }

          try {
            const media = [];
            for (const file of files) {
              const up = await api.uploadSocial(file);
              media.push({
                kind: up.kind,
                url: up.url,
                thumbUrl: up.thumbUrl,
                fileKey: up.fileKey,
                thumbKey: up.thumbKey
              });
            }
            await api.createPost({ body: body || null, media, poll });
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not publish that post.', { type: 'error' });
            return false;
          }

          // The post is saved. Refreshing the feed is a separate concern, so it
          // gets its own try: a failing reload must never be reported as "your
          // post failed" when the server already accepted it (a 201 followed by
          // a 500 on the feed used to show an error toast and keep the composer
          // open, so people posted the same thing twice).
          toast('Posted — live for 24 hours.', { type: 'success' });
          try {
            await load();
          } catch {
            toast('Posted, but the feed could not refresh. Pull to reload.', { type: 'info' });
          }
        }
      }
    ]
  });
}

async function postMenu(id) {
  const post = findPost(id);
  if (!post) return;

  const choice = await openModal({
    title: 'Post options',
    body: 'What would you like to do?',
    actions: post.isOwn
      ? [
          { label: 'Delete post', value: 'delete', class: 'btn-danger btn-block' },
          { label: 'Cancel', value: null, class: 'btn-secondary btn-block' }
        ]
      : [
          { label: 'Report post', value: 'report', class: 'btn-danger btn-block' },
          { label: 'Cancel', value: null, class: 'btn-secondary btn-block' }
        ]
  });

  if (choice === 'report') return reportSheet('post', id, 'this post');
  if (choice !== 'delete') return;

  const yes = await confirmDialog({
    title: 'Delete this post?',
    message: 'The post, its media and all of its comments are removed straight away.',
    confirmLabel: 'Delete',
    danger: true
  });
  if (!yes) return;
  try {
    await api.deletePost(id);
    toast('Post deleted.', { type: 'success' });
    await load();
  } catch {
    toast('Could not delete that post.', { type: 'error' });
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

export function initPosts() {
  $('#new-post')?.addEventListener('click', composer);

  const feed = $('#post-feed');

  feed.addEventListener('click', async (e) => {
    const like = e.target.closest('[data-like]');
    if (like) return toggleLike(like.dataset.like);

    const comments = e.target.closest('[data-comments]');
    if (comments) return openThread(comments.dataset.comments);

    const menu = e.target.closest('[data-menu]');
    if (menu) return postMenu(menu.dataset.menu);

    const voteBtn = e.target.closest('[data-vote]');
    if (voteBtn) {
      const card = voteBtn.closest('[data-post]');
      return vote(card.dataset.post, Number(voteBtn.dataset.vote));
    }

    const clike = e.target.closest('[data-clike]');
    if (clike) {
      try {
        const res = await api.likeComment(clike.dataset.clike);
        clike.textContent = `Like${res.count ? ` (${res.count})` : ''}`;
        clike.classList.toggle('text-brand-primary', res.liked);
      } catch {
        toast('Could not like that comment.', { type: 'error' });
      }
      return;
    }

    const creply = e.target.closest('[data-creply]');
    if (creply) return replyPrompt(creply.dataset.creply, creply.dataset.post);

    const creport = e.target.closest('[data-creport]');
    if (creport) return reportSheet('comment', creport.dataset.creport, 'this comment');

    const cdel = e.target.closest('[data-cdelete]');
    if (cdel) {
      const yes = await confirmDialog({
        title: 'Delete this comment?',
        message: 'Any replies to it are removed too.',
        confirmLabel: 'Delete',
        danger: true
      });
      if (!yes) return;
      try {
        await api.deleteComment(cdel.dataset.cdelete);
        const postId = cdel.closest('[data-post]').dataset.post;
        $(`[data-thread="${postId}"]`).classList.add('hidden');
        await openThread(postId);
      } catch {
        toast('Could not delete that comment.', { type: 'error' });
      }
    }
  });

  feed.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-cform]');
    if (!form) return;
    e.preventDefault();
    const postId = form.dataset.cform;
    const input = $(`[data-cinput="${postId}"]`);
    const body = input.value;
    input.value = '';
    submitComment(postId, body);
  });

  // Infinite scroll: load the next page when the sentinel comes into view.
  const sentinel = $('#feed-sentinel');
  if (sentinel && 'IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) load({ append: true });
      },
      { rootMargin: '400px' }
    ).observe(sentinel);
  }

  // Clicking a second notification while already on /moments is a same-document
  // hash change: nothing re-runs unless we listen for it.
  window.addEventListener('hashchange', () => {
    focusFromHash();
  });

  return load().then(() => focusFromHash());
}

/* ------------------------------------------------------------------ */
/* Deep links                                                          */
/* ------------------------------------------------------------------ */

/**
 * Notifications link to `/moments#post-<id>` and `/moments#comment-<id>`.
 * The browser's native anchor jump is useless here: the feed renders after
 * the document settles, so at jump time the target does not exist yet. Worse,
 * a comment lives inside a collapsed thread that has not been fetched.
 *
 * So: find the post (paginating deeper if it is below the loaded window),
 * open its thread when a comment was requested, then scroll and highlight.
 */
async function focusFromHash() {
  const hash = location.hash;
  if (!hash) return;

  const postMatch = /^#post-(\d+)$/.exec(hash);
  const commentMatch = /^#comment-(\d+)$/.exec(hash);
  if (!postMatch && !commentMatch) return;

  if (postMatch) {
    const el = await findPostCard(postMatch[1]);
    return el ? reveal(el) : toast('That post is no longer available.');
  }

  // A comment id does not tell us its post, so ask the server.
  let postId;
  try {
    ({ postId } = await api.commentContext(commentMatch[1]));
  } catch {
    return toast('That comment is no longer available.');
  }
  const card = await findPostCard(postId);
  if (!card) return toast('That post is no longer available.');

  const holder = $(`[data-thread="${postId}"]`);
  if (holder?.classList.contains('hidden')) await openThread(postId);

  // The thread renders asynchronously; wait for the comment to appear.
  const target = await waitFor(() => document.getElementById(`comment-${commentMatch[1]}`));
  reveal(target || card);
}

/** Locate a post card, loading further pages until found or exhausted. */
async function findPostCard(postId) {
  for (let i = 0; i < 10; i += 1) {
    const el = document.getElementById(`post-${postId}`);
    if (el) return el;
    if (exhausted) return null;
    await load({ append: true });
  }
  return null;
}

/** Poll briefly for an element that appears after an async render. */
function waitFor(fn, timeout = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const found = fn();
      if (found) return resolve(found);
      if (Date.now() - started > timeout) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Scroll to a deep-linked node and flash it so the eye finds it. */
function reveal(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('ring-2', 'ring-brand-primary');
  setTimeout(() => el.classList.remove('ring-2', 'ring-brand-primary'), 2200);
}
