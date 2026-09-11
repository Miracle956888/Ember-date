/**
 * admin-page — moderation dashboard.
 *
 * The server answers 404 (not 403) for a non-moderator, so the page treats a
 * failed `adminWhoami` as "you are not a moderator" and renders the denial
 * card. Nothing here assumes the client can be trusted with the decision: the
 * API enforces it independently on every call.
 */
import { api, ApiError } from '/js/api.js';
import { bootPage } from '/js/app-shell.js';
import { $, $$, el, toast, timeAgo, openModal, confirmDialog, withBusy } from '/js/ui.js';

const state = {
  role: null,
  tab: 'queue',
  auditCursor: null,
  loaded: new Set()
};

/* ------------------------------------------------------------- helpers -- */

const REASON_LABEL = {
  scam: 'Scam',
  fake: 'Fake profile',
  impersonation: 'Impersonation',
  harassment: 'Harassment',
  spam: 'Spam',
  threats: 'Threats',
  inappropriate: 'Inappropriate',
  ncii: 'Intimate images',
  other: 'Other'
};

const STATUS_CLASS = {
  active: 'bg-like/10 text-like',
  suspended: 'bg-super/10 text-super',
  banned: 'bg-nope/10 text-nope',
  open: 'bg-nope/10 text-nope',
  reviewing: 'bg-super/10 text-super',
  actioned: 'bg-like/10 text-like',
  dismissed: 'bg-surface-grey text-ink-soft'
};

function pill(text, kind) {
  return el('span', {
    class: `rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
      STATUS_CLASS[kind] || 'bg-surface-grey text-ink-soft'
    }`,
    text
  });
}

/** High-priority reports get a visible marker so they cannot be missed. */
function priorityFlag(priority) {
  if (priority >= 2) return pill('Urgent', 'open');
  if (priority === 1) return pill('Elevated', 'reviewing');
  return null;
}

function empty(message) {
  return el('div', {
    class: 'rounded-3xl border border-dashed border-line/[var(--line-a)] p-10 text-center text-[14px] text-ink-soft',
    text: message
  });
}

function card(children, attrs = {}) {
  return el('div', { class: 'rounded-3xl border border-line/[var(--line-a)] bg-surface p-4', ...attrs }, children);
}

/* ------------------------------------------------------- report queue --- */

async function loadQueue() {
  const list = $('#queue-list');
  list.replaceChildren(empty('Loading…'));

  try {
    const { reports } = await api.adminReports({
      status: $('#queue-status').value,
      targetType: $('#queue-type').value,
      limit: 25
    });

    const badge = $('[data-admin-badge="queue"]');
    const openCount = reports.filter((r) => r.status === 'open').length;
    badge.textContent = String(openCount);
    badge.classList.toggle('hidden', openCount === 0);

    if (!reports.length) {
      list.replaceChildren(empty('Nothing in this queue. Good news.'));
      return;
    }
    list.replaceChildren(...reports.map(reportCard));
  } catch (err) {
    list.replaceChildren(empty(err.message || 'Could not load the queue.'));
  }
}

function reportCard(r) {
  const head = el('div', { class: 'flex flex-wrap items-center gap-2' }, [
    el('span', { class: 'text-[15px] font-bold text-ink', text: REASON_LABEL[r.reason] || r.reason }),
    pill(r.targetType, 'dismissed'),
    pill(r.status, r.status),
    priorityFlag(r.priority)
  ].filter(Boolean));

  const who = el('p', { class: 'mt-1.5 text-[13px] text-ink-soft' }, [
    el('span', { text: `Reported by @${r.reporter.username}` }),
    el('span', { text: r.reportedUser ? ` · about @${r.reportedUser.username}` : '' }),
    el('span', { text: ` · ${timeAgo(r.createdAt)}` })
  ]);

  const bits = [head, who];

  if (r.details) {
    bits.push(
      el('p', {
        class: 'mt-2 rounded-2xl bg-surface-grey px-3 py-2 text-[13.5px] italic text-ink-soft',
        text: `“${r.details}”`
      })
    );
  }

  // The snapshot is the evidence: reported content is ephemeral and is often
  // already gone by the time a moderator opens the queue.
  const snapText = snapshotText(r.snapshot);
  if (snapText) {
    bits.push(
      el('div', { class: 'mt-2 rounded-2xl border border-line/[var(--line-a)] p-3' }, [
        el('p', { class: 'mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Captured content' }),
        el('p', { class: 'whitespace-pre-wrap break-words text-[13.5px] text-ink', text: snapText })
      ])
    );
  }

  const actions = el('div', { class: 'mt-3 flex flex-wrap gap-2' });

  if (r.status === 'open') {
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn-secondary !py-2 text-[13.5px]',
        text: 'Start review',
        onClick: (e) => resolve(r.id, 'reviewing', e.currentTarget)
      })
    );
  }
  if (r.status === 'open' || r.status === 'reviewing') {
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn-secondary !py-2 text-[13.5px]',
        text: 'Dismiss',
        onClick: (e) => resolve(r.id, 'dismissed', e.currentTarget)
      })
    );
    if (['post', 'moment', 'comment'].includes(r.targetType)) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn-danger !py-2 text-[13.5px]',
          text: 'Remove content',
          onClick: () => removeContent(r)
        })
      );
    }
    if (r.reportedUser) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn-secondary !py-2 text-[13.5px]',
          text: `Review @${r.reportedUser.username}`,
          onClick: () => openUser(r.reportedUser.id)
        })
      );
    }
  }
  if (r.status === 'actioned' || r.status === 'dismissed') {
    actions.append(
      el('p', {
        class: 'text-[13px] text-ink-faint',
        text: `${r.status} by ${r.handledBy ? `@${r.handledBy}` : 'a moderator'}${
          r.resolution ? ` — ${r.resolution}` : ''
        }`
      })
    );
  }

  bits.push(actions);
  // Stable hook so tests can tell a rendered report from the loading placeholder.
  return card(bits, { 'data-report-card': String(r.id) });
}

/** Snapshots differ per content type; show whatever text the shape carries. */
function snapshotText(snap) {
  if (!snap || typeof snap !== 'object') return '';
  if (snap.note) return snap.note;
  const text = snap.body || snap.text || snap.bio || '';
  return typeof text === 'string' ? text.slice(0, 400) : '';
}

async function resolve(id, status, btn) {
  const done = btn ? withBusy(btn) : null;
  try {
    await api.adminResolveReport(id, { status });
    toast(`Report ${status}.`, { type: 'success' });
    await loadQueue();
  } catch (err) {
    toast(err.message || 'Could not update that report.', { type: 'error' });
  } finally {
    done?.();
  }
}

async function removeContent(r) {
  const okToRemove = await confirmDialog({
    title: 'Remove this content?',
    message:
      'It disappears for everyone immediately. The record is kept so the report stays reviewable.',
    confirmLabel: 'Remove',
    danger: true
  });
  if (!okToRemove) return;

  try {
    await api.adminRemoveContent({
      targetType: r.targetType,
      targetId: r.targetId,
      reason: REASON_LABEL[r.reason] || r.reason
    });
    await api.adminResolveReport(r.id, { status: 'actioned', resolution: 'Content removed' });
    toast('Content removed.', { type: 'success' });
    await loadQueue();
  } catch (err) {
    toast(err.message || 'Could not remove that content.', { type: 'error' });
  }
}

/* -------------------------------------------------------- user admin ---- */

async function loadUsers(evt) {
  evt?.preventDefault();
  const list = $('#user-list');
  list.replaceChildren(empty('Loading…'));

  try {
    const { users, total } = await api.adminUsers({
      q: $('#user-search').value.trim(),
      status: $('#user-status').value,
      limit: 25
    });

    $('#user-count').textContent = total
      ? `${total} account${total === 1 ? '' : 's'}${users.length < total ? ` · showing ${users.length}` : ''}`
      : '';

    if (!users.length) {
      list.replaceChildren(empty('No user found.'));
      return;
    }
    list.replaceChildren(...users.map(userRow));
  } catch (err) {
    list.replaceChildren(empty(err.message || 'Could not search users.'));
  }
}

function userRow(u) {
  const meta = [`@${u.username}`];
  if (u.openReports) meta.push(`${u.openReports} open report${u.openReports === 1 ? '' : 's'}`);
  if (u.role !== 'user') meta.push(u.role);

  return el(
    'button',
    {
      type: 'button',
      class:
        'flex w-full items-center gap-3 rounded-2xl border border-line/[var(--line-a)] p-3 text-left transition hover:bg-surface-grey',
      onClick: () => openUser(u.id)
    },
    [
      el('img', { src: u.avatarUrl || '', alt: '', class: 'avatar h-11 w-11 shrink-0' }),
      el('div', { class: 'min-w-0 flex-1' }, [
        el('p', { class: 'truncate text-[15px] font-semibold text-ink', text: u.displayName || u.username }),
        el('p', { class: 'truncate text-[13px] text-ink-soft', text: meta.join(' · ') })
      ]),
      pill(u.status, u.status)
    ]
  );
}

async function openUser(id) {
  let data;
  try {
    data = await api.adminUser(id);
  } catch (err) {
    toast(err.message || 'Could not load that account.', { type: 'error' });
    return;
  }
  const { user: u, stats, reportsAgainst, moderationHistory } = data;

  const body = el('div', { class: 'text-left' });

  body.append(
    el('div', { class: 'flex items-center gap-3' }, [
      el('img', { src: u.avatarUrl || '', alt: '', class: 'avatar h-14 w-14' }),
      el('div', { class: 'min-w-0' }, [
        el('p', { class: 'truncate text-[16px] font-bold text-ink', text: u.displayName || u.username }),
        el('p', { class: 'truncate text-[13px] text-ink-soft', text: `@${u.username} · ${u.email}` })
      ]),
      pill(u.status, u.status)
    ])
  );

  if (u.statusReason) {
    body.append(el('p', { class: 'mt-2 text-[13px] text-ink-soft', text: `Reason on file: ${u.statusReason}` }));
  }

  const grid = el('div', { class: 'mt-4 grid grid-cols-3 gap-2' });
  for (const [label, value] of [
    ['Matches', stats.matches],
    ['Messages', stats.messages],
    ['Posts', stats.posts],
    ['Moments', stats.moments],
    ['Reports filed', stats.reportsFiled],
    ['Open reports', stats.openReports]
  ]) {
    grid.append(
      el('div', { class: 'rounded-2xl bg-surface-grey p-2.5 text-center' }, [
        el('p', { class: 'text-[17px] font-extrabold text-ink', text: String(value) }),
        el('p', { class: 'text-[11px] text-ink-faint', text: label })
      ])
    );
  }
  body.append(grid);

  const verif = [
    u.emailVerified ? 'email' : null,
    u.phoneVerified ? 'phone' : null,
    u.verified ? 'photo' : null
  ].filter(Boolean);
  body.append(
    el('p', {
      class: 'mt-3 text-[13px] text-ink-soft',
      text: `Verified: ${verif.length ? verif.join(', ') : 'none'} · joined ${timeAgo(u.createdAt)} · profile ${u.profileCompletion}% complete`
    })
  );

  if (reportsAgainst.length) {
    body.append(
      el('p', { class: 'mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Reports against' })
    );
    const ul = el('ul', { class: 'mt-1 flex flex-col gap-1' });
    for (const r of reportsAgainst.slice(0, 5)) {
      ul.append(
        el('li', {
          class: 'text-[13px] text-ink-soft',
          text: `${REASON_LABEL[r.reason] || r.reason} · ${r.targetType} · ${r.status} · ${timeAgo(r.createdAt)}`
        })
      );
    }
    body.append(ul);
  }

  if (moderationHistory.length) {
    body.append(
      el('p', {
        class: 'mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-faint',
        text: 'Moderation history'
      })
    );
    const ul = el('ul', { class: 'mt-1 flex flex-col gap-1' });
    for (const h of moderationHistory.slice(0, 5)) {
      ul.append(
        el('li', {
          class: 'text-[13px] text-ink-soft',
          text: `${h.action} by @${h.actor} · ${timeAgo(h.createdAt)}${h.detail ? ` — ${h.detail}` : ''}`
        })
      );
    }
    body.append(ul);
  }

  const actions = [{ label: 'Close', value: null, class: 'btn-secondary' }];

  if (u.status === 'active') {
    actions.push({
      label: 'Suspend',
      class: 'btn-secondary',
      onClick: async () => {
        await suspendFlow(u);
        return true;
      }
    });
  } else {
    actions.push({
      label: 'Restore',
      class: 'btn-primary',
      onClick: async () => {
        await act(() => api.adminRestore(u.id, { reason: 'Restored from dashboard' }), 'Account restored.');
        return true;
      }
    });
  }

  if (state.role === 'admin' && u.status !== 'banned') {
    actions.push({
      label: 'Ban',
      class: 'btn-danger',
      onClick: async () => {
        await banFlow(u);
        return true;
      }
    });
  }

  await openModal({ title: 'Account review', body, actions });
}

async function suspendFlow(u) {
  const wrap = el('div');
  wrap.append(
    el('label', { class: 'label', for: 'suspend-days', text: 'Length' }),
    el('select', { class: 'field', id: 'suspend-days' }, [
      el('option', { value: '1', text: '1 day' }),
      el('option', { value: '3', text: '3 days' }),
      el('option', { value: '7', text: '7 days', selected: true }),
      el('option', { value: '30', text: '30 days' })
    ]),
    el('label', { class: 'label mt-3', for: 'suspend-reason', text: 'Reason (recorded in the audit log)' }),
    el('input', { class: 'field', id: 'suspend-reason', type: 'text', maxlength: '200', placeholder: 'e.g. repeated harassment' })
  );

  // The form values must be read while the dialog is still mounted: openModal
  // detaches the panel before it resolves, so querying these ids afterwards
  // silently yields nothing and the action would post its defaults instead of
  // what the moderator actually chose.
  let chosen = null;
  const confirmed = await openModal({
    title: `Suspend @${u.username}?`,
    body: wrap,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      {
        label: 'Suspend',
        value: true,
        class: 'btn-danger',
        onClick: () => {
          chosen = {
            days: Number(wrap.querySelector('#suspend-days')?.value || 7),
            reason: wrap.querySelector('#suspend-reason')?.value.trim() || null
          };
        }
      }
    ]
  });
  if (confirmed !== true || !chosen) return;

  await act(() => api.adminSuspend(u.id, chosen), 'Account suspended.');
}

async function banFlow(u) {
  const wrap = el('div');
  wrap.append(
    el('p', {
      class: 'text-[14px] text-ink-soft',
      text: 'A ban is permanent and ends every active session immediately.'
    }),
    el('label', { class: 'label mt-3', for: 'ban-reason', text: 'Reason (recorded in the audit log)' }),
    el('input', { class: 'field', id: 'ban-reason', type: 'text', maxlength: '200' })
  );

  // Same reason as suspendFlow: read the field before the dialog unmounts.
  let reason = null;
  const confirmed = await openModal({
    title: `Ban @${u.username}?`,
    body: wrap,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      {
        label: 'Ban permanently',
        value: true,
        class: 'btn-danger',
        onClick: () => {
          reason = wrap.querySelector('#ban-reason')?.value.trim() || null;
        }
      }
    ]
  });
  if (confirmed !== true) return;

  await act(() => api.adminBan(u.id, { reason }), 'Account banned.');
}

async function act(fn, successMessage) {
  try {
    await fn();
    toast(successMessage, { type: 'success' });
    await loadUsers();
    if (state.loaded.has('queue')) await loadQueue();
  } catch (err) {
    toast(err.message || 'That action failed.', { type: 'error' });
  }
}

/* --------------------------------------------------------- analytics ---- */

async function loadAnalytics() {
  const root = $('#analytics-body');
  root.replaceChildren(empty('Loading…'));

  try {
    const a = await api.adminOverview();
    root.replaceChildren(
      statGroup('People', [
        ['Total users', a.users.total],
        ['New today', a.users.new24h],
        ['New this week', a.users.new7d],
        ['Active today', a.users.active24h],
        ['Active this week', a.users.active7d],
        ['Online now', a.users.onlineNow]
      ]),
      statGroup('Connections', [
        ['Matches', a.engagement.matchesTotal],
        ['Matches today', a.engagement.matches24h],
        ['Messages', a.engagement.messagesTotal],
        ['Messages today', a.engagement.messages24h],
        ['Swipes', a.engagement.swipesTotal]
      ]),
      statGroup('Live content', [
        ['Posts', a.content.postsLive],
        ['Posts today', a.content.posts24h],
        ['Moments', a.content.momentsLive],
        ['Moments today', a.content.moments24h],
        ['Comments', a.content.commentsLive]
      ]),
      statGroup('Safety', [
        ['Open reports', a.reports.open],
        ['Urgent', a.reports.urgent],
        ['Reviewing', a.reports.reviewing],
        ['Actioned', a.reports.actioned],
        ['Dismissed', a.reports.dismissed],
        ['Suspended accounts', a.users.suspended],
        ['Banned accounts', a.users.banned],
        ['Reports / 1k messages', a.reports.per1kMessages]
      ]),
      statGroup('Verification', [
        ['Email verified', `${a.verification.emailRate}%`],
        ['Phone verified', `${a.verification.phoneRate}%`],
        ['Photo verified', `${a.verification.photoRate}%`]
      ])
    );
  } catch (err) {
    root.replaceChildren(empty(err.message || 'Could not load analytics.'));
  }
}

function statGroup(title, rows) {
  const grid = el('div', { class: 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4' });
  for (const [label, value] of rows) {
    grid.append(
      el('div', { class: 'rounded-2xl border border-line/[var(--line-a)] bg-surface p-3' }, [
        el('p', { class: 'text-[20px] font-extrabold leading-tight text-ink', text: String(value) }),
        el('p', { class: 'mt-0.5 text-[12px] text-ink-soft', text: label })
      ])
    );
  }
  return el('section', {}, [
    el('h2', { class: 'mb-2 text-[13px] font-bold uppercase tracking-wide text-ink-faint', text: title }),
    grid
  ]);
}

/* -------------------------------------------------------- audit log ----- */

async function loadAudit(append = false) {
  const list = $('#audit-list');
  if (!append) list.replaceChildren(empty('Loading…'));

  try {
    const { entries, nextCursor } = await api.adminAudit({
      limit: 25,
      before: append ? state.auditCursor : null
    });

    if (!append) list.replaceChildren();
    if (!entries.length && !append) {
      list.replaceChildren(empty('No moderation actions recorded yet.'));
      return;
    }

    for (const e of entries) {
      list.append(
        el('div', { class: 'rounded-2xl border border-line/[var(--line-a)] p-3' }, [
          el('div', { class: 'flex flex-wrap items-center gap-2' }, [
            el('span', { class: 'text-[14px] font-bold text-ink', text: e.action }),
            el('span', { class: 'text-[13px] text-ink-soft', text: `by @${e.actor.username}` }),
            el('span', { class: 'text-[13px] text-ink-faint', text: timeAgo(e.createdAt) })
          ]),
          el('p', {
            class: 'mt-1 text-[13px] text-ink-soft',
            text: [
              e.targetType ? `${e.targetType} #${e.targetId}` : null,
              e.detail || null,
              e.ip ? `from ${e.ip}` : null
            ]
              .filter(Boolean)
              .join(' · ')
          })
        ])
      );
    }

    state.auditCursor = nextCursor;
    $('#audit-more').classList.toggle('hidden', !nextCursor);
  } catch (err) {
    if (!append) list.replaceChildren(empty(err.message || 'Could not load the audit log.'));
  }
}

/* ---------------------------------------------------------------- tabs -- */

function showTab(name) {
  state.tab = name;
  for (const btn of $$('[data-admin-tab]')) {
    const on = btn.dataset.adminTab === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panel of $$('[data-admin-panel]')) {
    panel.hidden = panel.dataset.adminPanel !== name;
  }

  // Load a panel the first time it is opened, so switching tabs is instant
  // afterwards and the dashboard does not fire four queries on boot.
  if (state.loaded.has(name)) return;
  state.loaded.add(name);
  if (name === 'queue') loadQueue();
  if (name === 'users') loadUsers();
  if (name === 'analytics') loadAnalytics();
  if (name === 'audit') loadAudit();
}

/* ---------------------------------------------------------------- boot -- */

await bootPage({ socket: true, badges: true });

let whoami = null;
try {
  whoami = await api.adminWhoami();
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  // 404 is the deliberate answer for a non-moderator.
}

if (!whoami) {
  $('#admin-denied').classList.remove('hidden');
} else {
  state.role = whoami.role;
  $('#admin-body').classList.remove('hidden');

  const chip = $('#admin-role-chip');
  chip.textContent = whoami.role;
  chip.classList.remove('hidden');

  if (whoami.canAudit) $('#admin-audit-tab').classList.remove('hidden');

  for (const btn of $$('[data-admin-tab]')) {
    btn.addEventListener('click', () => showTab(btn.dataset.adminTab));
  }
  $('#queue-status').addEventListener('change', loadQueue);
  $('#queue-type').addEventListener('change', loadQueue);
  $('#queue-refresh').addEventListener('click', loadQueue);
  $('#user-search-form').addEventListener('submit', loadUsers);
  $('#audit-more').addEventListener('click', () => loadAudit(true));

  showTab('queue');
}
