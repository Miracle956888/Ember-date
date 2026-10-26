/**
 * Permission-aware staff console. The browser only hides unavailable actions;
 * every API request is independently authorized on the server.
 */
import { api, ApiError } from '/js/api.js';
import { bootPage } from '/js/app-shell.js';
import { $, $$, el, toast, timeAgo, openModal, confirmDialog, withBusy } from '/js/ui.js';

const state = {
  role: null,
  userId: null,
  permissions: new Set(),
  tab: null,
  queueCursor: null,
  auditCursor: null,
  activityCursor: null,
  verificationCursor: null,
  userOffset: 0,
  loaded: new Set()
};

const ROLE_RANK = {
  user: 0,
  support_agent: 1,
  analyst: 1,
  moderator: 2,
  auditor: 2,
  admin: 3,
  super_admin: 4
};

const REASON_LABEL = {
  scam: 'Scam', fake: 'Fake profile', impersonation: 'Impersonation', harassment: 'Harassment',
  spam: 'Spam', threats: 'Threats', inappropriate: 'Inappropriate', ncii: 'Intimate images', other: 'Other'
};
const GESTURE_LABEL = {
  peace: 'Hold up a peace sign next to your face',
  thumbs_up: 'Give a thumbs up',
  hand_on_head: 'Place one hand flat on top of your head',
  point_up: 'Point one finger straight up',
  open_palm: 'Show an open palm beside your cheek',
  wave: 'Wave at the camera'
};
const STATUS_CLASS = {
  active: 'bg-like/10 text-like', suspended: 'bg-super/10 text-super', banned: 'bg-nope/10 text-nope',
  open: 'bg-nope/10 text-nope', reviewing: 'bg-super/10 text-super', actioned: 'bg-like/10 text-like',
  dismissed: 'bg-surface-grey text-ink-soft'
};

function can(permission) {
  return state.permissions.has('*') || state.permissions.has(permission);
}

function mayTarget(user) {
  return Number(user.id) !== Number(state.userId) &&
    (ROLE_RANK[user.role] ?? 0) < (ROLE_RANK[state.role] ?? 0);
}

function pill(text, kind) {
  return el('span', {
    class: `rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${STATUS_CLASS[kind] || 'bg-surface-grey text-ink-soft'}`,
    text: String(text ?? '')
  });
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

function statusText(value) {
  return value ? 'Available' : 'Unavailable';
}

// --------------------------------------------------------------- reports

async function loadQueue(append = false) {
  const list = $('#queue-list');
  const more = $('#queue-more');
  if (!append) {
    state.queueCursor = null;
    list.replaceChildren(empty('Loading…'));
  }
  try {
    const params = {
      status: $('#queue-status').value,
      targetType: $('#queue-type').value,
      limit: 25
    };
    if (append && state.queueCursor) {
      params.cursorPriority = state.queueCursor.priority;
      params.cursorId = state.queueCursor.id;
    }
    const { reports, nextCursor } = await api.adminReports(params);
    const badge = $('[data-admin-badge="queue"]');
    const openCount = reports.filter((report) => report.status === 'open').length;
    badge.textContent = nextCursor ? '25+' : String(openCount);
    badge.classList.toggle('hidden', $('#queue-status').value !== 'open' || openCount === 0);

    if (!append) list.replaceChildren();
    if (!reports.length && !append) list.replaceChildren(empty('Nothing in this queue.'));
    else list.append(...reports.map(reportCard));
    state.queueCursor = nextCursor;
    more.classList.toggle('hidden', !nextCursor);
  } catch (error) {
    if (!append) list.replaceChildren(empty(error.message || 'Could not load the queue.'));
    more.classList.add('hidden');
  }
}

function reportCard(report) {
  const head = el('div', { class: 'flex flex-wrap items-center gap-2' }, [
    el('span', { class: 'text-[15px] font-bold text-ink', text: REASON_LABEL[report.reason] || report.reason }),
    pill(report.targetType, 'dismissed'),
    pill(report.status, report.status),
    report.priority >= 2 ? pill('Urgent', 'open') : report.priority === 1 ? pill('Elevated', 'reviewing') : null
  ].filter(Boolean));

  const who = el('p', { class: 'mt-1.5 text-[13px] text-ink-soft' }, [
    el('span', { text: `Reported by @${report.reporter?.username || 'unknown'}` }),
    el('span', { text: report.reportedUser ? ` · about @${report.reportedUser.username}` : '' }),
    el('span', { text: ` · ${timeAgo(report.createdAt)}` })
  ]);
  const content = [head, who];

  if (report.details) {
    content.push(el('p', {
      class: 'mt-2 rounded-2xl bg-surface-grey px-3 py-2 text-[13.5px] italic text-ink-soft',
      text: `“${report.details}”`
    }));
  }
  const captured = snapshotText(report.snapshot);
  if (captured) {
    content.push(el('div', { class: 'mt-2 rounded-2xl border border-line/[var(--line-a)] p-3' }, [
      el('p', { class: 'mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Captured content' }),
      el('p', { class: 'whitespace-pre-wrap break-words text-[13.5px] text-ink', text: captured })
    ]));
  }

  const assignment = report.assignedTo ? `Assigned to @${report.assignedTo}` : 'Unassigned';
  content.push(el('p', { class: 'mt-2 text-[12px] text-ink-faint', text: assignment }));

  const actions = el('div', { class: 'mt-3 flex flex-wrap gap-2' });
  if (can('reports:read')) {
    actions.append(el('button', {
      type: 'button', class: 'btn-secondary !py-2 text-[13.5px]', text: can('reports:notes') ? 'Details & notes' : 'Details',
      onClick: () => openReportDetails(report.id)
    }));
  }
  if (can('reports:manage') && ['open', 'reviewing'].includes(report.status)) {
    if (report.status === 'open') actions.append(el('button', {
      type: 'button', class: 'btn-secondary !py-2 text-[13.5px]', text: 'Start review',
      onClick: (event) => resolveReport(report.id, 'reviewing', event.currentTarget)
    }));
    actions.append(el('button', {
      type: 'button', class: 'btn-primary !py-2 text-[13.5px]', text: 'Mark actioned',
      onClick: (event) => resolveReport(report.id, 'actioned', event.currentTarget)
    }));
    actions.append(el('button', {
      type: 'button', class: 'btn-secondary !py-2 text-[13.5px]', text: 'Dismiss',
      onClick: (event) => resolveReport(report.id, 'dismissed', event.currentTarget)
    }));
    if (report.assignedTo !== undefined) actions.append(el('button', {
      type: 'button', class: 'btn-ghost !py-2 text-[13.5px]', text: 'Assign to me',
      onClick: (event) => assignReport(report.id, state.userId, event.currentTarget)
    }));
    if (report.assignedTo) actions.append(el('button', {
      type: 'button', class: 'btn-ghost !py-2 text-[13.5px]', text: 'Clear assignment',
      onClick: (event) => assignReport(report.id, null, event.currentTarget)
    }));
  }
  if (can('content:remove') && ['open', 'reviewing'].includes(report.status) && ['post', 'moment', 'comment'].includes(report.targetType)) {
    actions.append(el('button', {
      type: 'button', class: 'btn-danger !py-2 text-[13.5px]', text: 'Remove content',
      onClick: () => removeContent(report)
    }));
  }
  if (report.reportedUser && can('users:read_detail')) actions.append(el('button', {
    type: 'button', class: 'btn-secondary !py-2 text-[13.5px]', text: `Review @${report.reportedUser.username}`,
    onClick: () => openUser(report.reportedUser.id)
  }));
  if (['actioned', 'dismissed'].includes(report.status)) actions.append(el('p', {
    class: 'text-[13px] text-ink-faint',
    text: `${report.status} by ${report.handledBy ? `@${report.handledBy}` : 'a moderator'}${report.resolution ? ` — ${report.resolution}` : ''}`
  }));

  content.push(actions);
  return card(content, { 'data-report-card': String(report.id) });
}

function snapshotText(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  if (snapshot.note) return snapshot.note;
  const text = snapshot.body || snapshot.text || snapshot.bio || '';
  return typeof text === 'string' ? text.slice(0, 400) : '';
}

async function resolveReport(id, status, button) {
  const restore = button ? withBusy(button) : null;
  try {
    await api.adminResolveReport(id, { status });
    toast(`Report ${status}.`, { type: 'success' });
    await loadQueue();
  } catch (error) {
    toast(error.message || 'Could not update that report.', { type: 'error' });
  } finally {
    restore?.();
  }
}

async function assignReport(id, assigneeId, button) {
  const restore = button ? withBusy(button) : null;
  try {
    await api.adminAssignReport(id, assigneeId);
    toast(assigneeId ? 'Report assigned to you.' : 'Assignment cleared.', { type: 'success' });
    await loadQueue();
  } catch (error) {
    toast(error.message || 'Could not update the assignment.', { type: 'error' });
  } finally {
    restore?.();
  }
}

async function openReportDetails(id) {
  try {
    const report = await api.adminReport(id);
    const notesResult = can('reports:notes') ? await api.adminReportNotes(id) : { notes: [] };
    const body = el('div', { class: 'text-left' });
    body.append(
      el('p', { class: 'text-[13px] text-ink-soft', text: `${REASON_LABEL[report.reason] || report.reason} · ${report.targetType} · ${report.status}` }),
      el('p', { class: 'mt-1 text-[13px] text-ink-soft', text: `Reported by @${report.reporter?.username || 'unknown'}${report.reportedUser ? ` · about @${report.reportedUser.username}` : ''}` })
    );
    if (report.details) body.append(el('p', { class: 'mt-3 whitespace-pre-wrap text-[14px] text-ink', text: report.details }));
    const captured = snapshotText(report.snapshot);
    if (captured) body.append(el('div', { class: 'mt-3 rounded-2xl border border-line/[var(--line-a)] p-3' }, [
      el('p', { class: 'mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Captured content' }),
      el('p', { class: 'whitespace-pre-wrap break-words text-[14px] text-ink', text: captured })
    ]));
    if (report.history) body.append(el('p', {
      class: 'mt-3 text-[12px] text-ink-faint',
      text: `Report history for this account: ${report.history.total} total · ${report.history.actioned} actioned · ${report.history.pending} open/reviewing`
    }));

    if (can('reports:notes')) {
      body.append(el('h3', { class: 'mt-5 text-[12px] font-bold uppercase tracking-wide text-ink-faint', text: 'Internal staff notes' }));
      const notes = notesResult.notes || [];
      body.append(notes.length
        ? el('ul', { class: 'mt-2 flex flex-col gap-2' }, notes.map((note) => el('li', {
          class: 'rounded-xl bg-surface-grey p-3 text-[13px] text-ink',
          text: `${note.author} · ${timeAgo(note.createdAt)} — ${note.note}`
        })))
        : el('p', { class: 'mt-2 text-[13px] text-ink-faint', text: 'No internal notes.' }));
      body.append(el('p', {
        class: 'mt-3 text-[12px] text-ink-faint',
        text: 'Do not copy private message text, credentials, or unnecessary personal details into staff notes.'
      }));
    }

    const noteField = el('textarea', {
      class: 'field mt-2 min-h-24 resize-y',
      maxlength: '1000',
      placeholder: 'Add an internal note visible to authorized staff only…',
      'aria-label': 'Internal staff note'
    });
    const actions = [{ label: 'Close', value: null, class: 'btn-secondary' }];
    if (can('reports:notes')) {
      body.append(noteField);
      actions.push({
        label: 'Save note', value: true, class: 'btn-primary',
        onClick: async () => {
          const note = noteField.value.trim();
          if (!note) {
            toast('Write a note before saving.', { type: 'error' });
            return false;
          }
          try {
            await api.adminAddReportNote(id, note);
            toast('Internal note saved.', { type: 'success' });
            return true;
          } catch (error) {
            toast(error.message || 'Could not save the note.', { type: 'error' });
            return false;
          }
        }
      });
    }
    await openModal({ title: `Report #${id}`, body, actions });
  } catch (error) {
    toast(error.message || 'Could not load report details.', { type: 'error' });
  }
}

async function removeContent(report) {
  const confirmed = await confirmDialog({
    title: 'Remove this content?',
    message: 'It disappears for everyone immediately. The content row remains so staff can audit the action.',
    confirmLabel: 'Remove',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api.adminRemoveContent({ targetType: report.targetType, targetId: report.targetId });
    await api.adminResolveReport(report.id, { status: 'actioned', resolution: 'Content removed' });
    toast('Content removed and report actioned.', { type: 'success' });
    await loadQueue();
  } catch (error) {
    toast(error.message || 'Could not remove that content.', { type: 'error' });
    await loadQueue();
  }
}

// --------------------------------------------------------------- users

async function loadUsers(eventOrAppend = false) {
  const append = typeof eventOrAppend === 'boolean' ? eventOrAppend : false;
  if (eventOrAppend && typeof eventOrAppend.preventDefault === 'function') eventOrAppend.preventDefault();
  const list = $('#user-list');
  if (!append) {
    state.userOffset = 0;
    list.replaceChildren(empty('Loading…'));
  }
  try {
    const offset = state.userOffset;
    const { users, total, canViewSensitive } = await api.adminUsers({
      q: $('#user-search').value.trim(), status: $('#user-status').value, limit: 25, offset
    });
    if (!append) list.replaceChildren();
    if (!users.length && !append) list.replaceChildren(empty('No user found.'));
    else list.append(...users.map(userRow));
    state.userOffset = offset + users.length;
    $('#user-count').textContent = total
      ? `${total} account${total === 1 ? '' : 's'} · showing ${Math.min(state.userOffset, total)}${canViewSensitive ? ' · sensitive lookup enabled' : ''}`
      : 'No matching accounts.';
    $('#user-more').classList.toggle('hidden', state.userOffset >= total);
    if (canViewSensitive) $('#user-search').placeholder = 'Username, display name or exact email';
  } catch (error) {
    if (!append) list.replaceChildren(empty(error.message || 'Could not search users.'));
    $('#user-more').classList.add('hidden');
  }
}

function userRow(user) {
  const meta = [`@${user.username}`];
  if (user.openReports) meta.push(`${user.openReports} open report${user.openReports === 1 ? '' : 's'}`);
  if (user.role !== 'user') meta.push(user.role);
  return el('button', {
    type: 'button',
    class: 'flex w-full items-center gap-3 rounded-2xl border border-line/[var(--line-a)] p-3 text-left transition hover:bg-surface-grey',
    onClick: () => openUser(user.id)
  }, [
    el('img', { src: user.avatarUrl || '', alt: '', class: 'avatar h-11 w-11 shrink-0', referrerpolicy: 'no-referrer' }),
    el('div', { class: 'min-w-0 flex-1' }, [
      el('p', { class: 'truncate text-[15px] font-semibold text-ink', text: user.displayName || user.username }),
      el('p', { class: 'truncate text-[13px] text-ink-soft', text: meta.join(' · ') })
    ]),
    pill(user.status, user.status)
  ]);
}

async function openUser(id) {
  let data;
  try {
    data = await api.adminUser(id);
  } catch (error) {
    toast(error.message || 'Could not load that account.', { type: 'error' });
    return;
  }
  const { user, stats, reportsAgainst, moderationHistory } = data;
  const body = el('div', { class: 'text-left' });
  const identity = [
    el('img', { src: user.avatarUrl || '', alt: '', class: 'avatar h-14 w-14', referrerpolicy: 'no-referrer' }),
    el('div', { class: 'min-w-0 flex-1' }, [
      el('p', { class: 'truncate text-[16px] font-bold text-ink', text: user.displayName || user.username }),
      el('p', { class: 'truncate text-[13px] text-ink-soft', text: `@${user.username}${user.email ? ` · ${user.email}` : ''}` })
    ]),
    pill(user.status, user.status)
  ];
  body.append(el('div', { class: 'flex items-center gap-3' }, identity));
  if (user.statusReason) body.append(el('p', { class: 'mt-2 text-[13px] text-ink-soft', text: `Reason on file: ${user.statusReason}` }));

  body.append(statGrid([
    ['Matches', stats.matches], ['Messages counted', stats.messages], ['Posts', stats.posts],
    ['Moments', stats.moments], ['Reports filed', stats.reportsFiled], ['Open reports', stats.openReports]
  ]));
  const verified = [user.emailVerified ? 'email' : null, user.phoneVerified ? 'phone' : null, user.verified ? 'photo' : null].filter(Boolean);
  body.append(el('p', {
    class: 'mt-3 text-[13px] text-ink-soft',
    text: `Verified tiers: ${verified.length ? verified.join(', ') : 'none'} · joined ${timeAgo(user.createdAt)} · profile ${user.profileCompletion}% complete`
  }));

  if (reportsAgainst.length) {
    body.append(el('h3', { class: 'mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Reports against' }));
    body.append(el('ul', { class: 'mt-1 flex flex-col gap-1' }, reportsAgainst.slice(0, 5).map((report) => el('li', {
      class: 'text-[13px] text-ink-soft',
      text: `${REASON_LABEL[report.reason] || report.reason} · ${report.targetType} · ${report.status} · ${timeAgo(report.createdAt)}`
    }))));
  }
  if (moderationHistory.length) {
    body.append(el('h3', { class: 'mt-4 text-[11px] font-bold uppercase tracking-wide text-ink-faint', text: 'Moderation history' }));
    body.append(el('ul', { class: 'mt-1 flex flex-col gap-1' }, moderationHistory.slice(0, 5).map((item) => el('li', {
      class: 'text-[13px] text-ink-soft',
      text: `${item.action} by @${item.actor || 'deleted staff account'} · ${timeAgo(item.createdAt)}${item.detail ? ` — ${item.detail}` : ''}`
    }))));
  }

  const actions = [{ label: 'Close', value: null, class: 'btn-secondary' }];
  const targetable = mayTarget(user);
  if (targetable && user.status === 'active' && can('users:suspend')) actions.push({
    label: 'Suspend', class: 'btn-secondary', onClick: async () => { await suspendFlow(user); return true; }
  });
  if (targetable && user.status === 'suspended' && can('users:restore')) actions.push({
    label: 'Restore', class: 'btn-primary', onClick: async () => { await act(() => api.adminRestore(user.id, {}), 'Account restored.'); return true; }
  });
  if (targetable && user.status === 'banned' && can('users:ban')) actions.push({
    label: 'Restore ban', class: 'btn-primary', onClick: async () => { await act(() => api.adminRestore(user.id, {}), 'Account restored.'); return true; }
  });
  if (targetable && user.status !== 'banned' && can('users:ban')) actions.push({
    label: 'Ban', class: 'btn-danger', onClick: async () => { await banFlow(user); return true; }
  });
  if (targetable && can('roles:manage')) actions.push({
    label: 'Change role', class: 'btn-secondary', onClick: async () => { await roleFlow(user); return true; }
  });
  await openModal({ title: 'Account review', body, actions });
}

function statGrid(rows) {
  const grid = el('div', { class: 'mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3' });
  for (const [label, value] of rows) grid.append(el('div', { class: 'rounded-2xl bg-surface-grey p-2.5 text-center' }, [
    el('p', { class: 'text-[17px] font-extrabold text-ink', text: String(value ?? 0) }),
    el('p', { class: 'text-[11px] text-ink-faint', text: label })
  ]));
  return grid;
}

async function suspendFlow(user) {
  const form = el('div');
  form.append(
    el('label', { class: 'label', for: 'suspend-days', text: 'Length' }),
    el('select', { class: 'field', id: 'suspend-days' }, [
      el('option', { value: '1', text: '1 day' }), el('option', { value: '3', text: '3 days' }),
      el('option', { value: '7', text: '7 days', selected: true }), el('option', { value: '30', text: '30 days' })
    ]),
    el('label', { class: 'label mt-3', for: 'suspend-reason', text: 'Reason (visible to authorized staff)' }),
    el('input', { class: 'field', id: 'suspend-reason', type: 'text', maxlength: '200', placeholder: 'e.g. repeated harassment' })
  );
  let chosen = null;
  const confirmed = await openModal({
    title: `Suspend @${user.username}?`, body: form,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      { label: 'Suspend', value: true, class: 'btn-danger', onClick: () => {
        chosen = { days: Number(form.querySelector('#suspend-days').value), reason: form.querySelector('#suspend-reason').value.trim() || null };
      } }
    ]
  });
  if (confirmed && chosen) await act(() => api.adminSuspend(user.id, chosen), 'Account suspended.');
}

async function banFlow(user) {
  const form = el('div');
  form.append(
    el('p', { class: 'text-[14px] text-ink-soft', text: 'A permanent ban ends this account’s active sessions immediately.' }),
    el('label', { class: 'label mt-3', for: 'ban-reason', text: 'Reason (visible to authorized staff)' }),
    el('input', { class: 'field', id: 'ban-reason', type: 'text', maxlength: '200' })
  );
  let reason = null;
  const confirmed = await openModal({
    title: `Ban @${user.username}?`, body: form,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      { label: 'Ban permanently', value: true, class: 'btn-danger', onClick: () => {
        reason = form.querySelector('#ban-reason').value.trim() || null;
      } }
    ]
  });
  if (confirmed) await act(() => api.adminBan(user.id, { reason }), 'Account banned.');
}

async function roleFlow(user) {
  const actorRank = ROLE_RANK[state.role] ?? 0;
  const roles = ['user', 'support_agent', 'analyst', 'moderator', 'auditor', 'admin']
    .filter((role) => role === user.role || (ROLE_RANK[role] ?? 0) < actorRank);
  const select = el('select', { class: 'field', 'aria-label': 'New role' }, roles.map((role) => el('option', {
    value: role, text: role, selected: role === user.role
  })));
  const body = el('div', {}, [
    el('p', { class: 'mb-3 text-[13px] text-ink-soft', text: 'Roles grant access to specific staff actions. The server blocks self-promotion and changes at or above your own rank.' }),
    select
  ]);
  let role = null;
  const confirmed = await openModal({
    title: `Change @${user.username}’s role?`, body,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      { label: 'Save role', value: true, class: 'btn-primary', onClick: () => { role = select.value; } }
    ]
  });
  if (confirmed && role && role !== user.role) await act(() => api.adminSetRole(user.id, role), `Role set to ${role}.`);
}

async function act(action, successMessage) {
  try {
    await action();
    toast(successMessage, { type: 'success' });
    if (state.loaded.has('users')) await loadUsers();
    if (state.loaded.has('queue')) await loadQueue();
    if (state.loaded.has('verification')) await loadVerifications();
  } catch (error) {
    toast(error.message || 'That action failed.', { type: 'error' });
  }
}

// ----------------------------------------------------------- verification

async function loadVerifications(append = false) {
  const list = $('#verification-list');
  if (!append) {
    state.verificationCursor = null;
    list.replaceChildren(empty('Loading…'));
  }
  try {
    const params = { limit: 25 };
    if (append && state.verificationCursor) params.before = state.verificationCursor;
    const { verifications, nextCursor } = await api.adminVerifications(params);
    if (!append) list.replaceChildren();
    if (!verifications.length && !append) list.replaceChildren(empty('No pending photo-verification requests.'));
    else list.append(...verifications.map(verificationCard));
    state.verificationCursor = nextCursor;
    $('#verification-more').classList.toggle('hidden', !nextCursor);
  } catch (error) {
    if (!append) list.replaceChildren(empty(error.message || 'Could not load verification requests.'));
    $('#verification-more').classList.add('hidden');
  }
}

function verificationCard(request) {
  const body = el('div', { class: 'flex min-w-0 flex-1 flex-col gap-2' });
  body.append(
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      el('p', { class: 'font-bold text-ink', text: request.displayName || request.username }),
      el('span', { class: 'text-[13px] text-ink-soft', text: `@${request.username}` }),
      pill('pending', 'reviewing')
    ]),
    el('p', { class: 'text-[13px] text-ink-soft', text: `Challenge: ${GESTURE_LABEL[request.gesture] || request.gesture} · submitted ${timeAgo(request.submittedAt)}` })
  );

  if (can('verification:review')) body.append(el('img', {
    src: api.adminVerificationEvidenceUrl(request.id),
    alt: `Private verification evidence for @${request.username}; requested pose: ${GESTURE_LABEL[request.gesture] || request.gesture}`,
    class: 'mt-1 max-h-[360px] max-w-full self-start rounded-2xl border border-line/[var(--line-a)] object-contain',
    loading: 'lazy',
    referrerpolicy: 'no-referrer'
  }));

  const note = el('textarea', {
    class: 'field mt-2 min-h-20 resize-y',
    maxlength: '255',
    placeholder: 'Optional short explanation visible to the user (avoid sensitive details).',
    'aria-label': 'User-visible verification review note'
  });
  const actions = el('div', { class: 'mt-3 flex flex-wrap gap-2' });
  if (can('verification:review')) {
    actions.append(
      el('button', { type: 'button', class: 'btn-primary !py-2 text-[13.5px]', text: 'Approve', onClick: (event) => reviewVerification(request, 'approved', note, event.currentTarget) }),
      el('button', { type: 'button', class: 'btn-danger !py-2 text-[13.5px]', text: 'Reject', onClick: (event) => reviewVerification(request, 'rejected', note, event.currentTarget) })
    );
    body.append(note);
  }
  body.append(actions);
  return card(body, { 'data-verification-card': String(request.id) });
}

async function reviewVerification(request, decision, noteInput, button) {
  const verb = decision === 'approved' ? 'approve' : 'reject';
  const confirmed = await confirmDialog({
    title: `${verb[0].toUpperCase()}${verb.slice(1)} photo verification?`,
    message: 'The user will see the outcome. Private evidence is queued for deletion after this decision.',
    confirmLabel: verb[0].toUpperCase() + verb.slice(1),
    danger: decision === 'rejected'
  });
  if (!confirmed) return;
  const restore = withBusy(button);
  try {
    await api.adminReviewVerification(request.id, { decision, note: noteInput.value.trim() || null });
    toast(`Photo verification ${decision}.`, { type: 'success' });
    await loadVerifications();
  } catch (error) {
    toast(error.message || 'Could not review this request.', { type: 'error' });
  } finally {
    restore();
  }
}

// ------------------------------------------------------------- analytics

async function loadAnalytics() {
  const root = $('#analytics-body');
  root.replaceChildren(empty('Loading…'));
  try {
    const data = await api.adminOverview();
    root.replaceChildren(
      statGroup('People', [
        ['Total user accounts', data.users.total], ['New in 24 hours', data.users.new24h],
        ['New in 7 days', data.users.new7d], ['Active in 24 hours', data.users.active24h],
        ['Active in 7 days', data.users.active7d], ['Online now', data.users.onlineNow]
      ]),
      statGroup('Connections', [
        ['Match records', data.engagement.matchesTotal], ['Matches in 24 hours', data.engagement.matches24h],
        ['Messages currently retained', data.engagement.messagesTotal], ['Messages created in 24 hours', data.engagement.messages24h],
        ['Swipe records', data.engagement.swipesTotal]
      ]),
      statGroup('Live content', [
        ['Live posts', data.content.postsLive], ['Posts created in 24 hours', data.content.posts24h],
        ['Live moments', data.content.momentsLive], ['Moments created in 24 hours', data.content.moments24h],
        ['Live comments', data.content.commentsLive]
      ]),
      statGroup('Safety', [
        ['Open reports', data.reports.open], ['Urgent reports', data.reports.urgent],
        ['Reviewing reports', data.reports.reviewing], ['Actioned reports', data.reports.actioned],
        ['Dismissed reports', data.reports.dismissed], ['Suspended accounts', data.users.suspended],
        ['Message reports per 1,000 messages (24h)', data.reports.messageReportsPer1kMessages24h],
        ['Message reports in 24 hours', data.reports.messageReports24h], ['Banned accounts', data.users.banned]
      ]),
      statGroup('Verification rates', [
        ['Email confirmed', `${data.verification.emailRate}%`], ['Phone confirmed', `${data.verification.phoneRate}%`],
        ['Photo reviewed', `${data.verification.photoRate}%`]
      ]),
      el('p', { class: 'text-[11px] text-ink-faint', text: `Database-backed counts · generated ${new Date(data.generatedAt).toLocaleString()}` })
    );
  } catch (error) {
    root.replaceChildren(empty(error.message || 'Could not load analytics.'));
  }
}

function statGroup(title, rows) {
  const grid = el('div', { class: 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4' });
  for (const [label, value] of rows) grid.append(el('div', { class: 'rounded-2xl border border-line/[var(--line-a)] bg-surface p-3' }, [
    el('p', { class: 'text-[20px] font-extrabold leading-tight text-ink', text: String(value ?? '—') }),
    el('p', { class: 'mt-0.5 text-[12px] text-ink-soft', text: label })
  ]));
  return el('section', {}, [
    el('h2', { class: 'mb-2 text-[13px] font-bold uppercase tracking-wide text-ink-faint', text: title }), grid
  ]);
}

// --------------------------------------------------------------- audit

async function loadAudit(append = false) {
  const list = $('#audit-list');
  if (!append) {
    state.auditCursor = null;
    list.replaceChildren(empty('Loading…'));
  }
  try {
    const { entries, nextCursor } = await api.adminAudit({ limit: 25, before: append ? state.auditCursor : null });
    if (!append) list.replaceChildren();
    if (!entries.length && !append) list.replaceChildren(empty('No staff actions recorded yet.'));
    for (const entry of entries) {
      list.append(el('div', { class: 'rounded-2xl border border-line/[var(--line-a)] p-3' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('span', { class: 'text-[14px] font-bold text-ink', text: entry.action }),
          el('span', { class: 'text-[13px] text-ink-soft', text: `by @${entry.actor?.username || 'deleted staff account'}` }),
          el('span', { class: 'text-[13px] text-ink-faint', text: timeAgo(entry.createdAt) })
        ]),
        el('p', { class: 'mt-1 text-[13px] text-ink-soft', text: [
          entry.targetType ? `${entry.targetType} #${entry.targetId}` : null,
          entry.detail || null,
          entry.ip ? `from ${entry.ip}` : null
        ].filter(Boolean).join(' · ') })
      ]));
    }
    state.auditCursor = nextCursor;
    $('#audit-more').classList.toggle('hidden', !nextCursor);
  } catch (error) {
    if (!append) list.replaceChildren(empty(error.message || 'Could not load the audit log.'));
    $('#audit-more').classList.add('hidden');
  }
}

async function loadActivity(append = false) {
  const list = $('#activity-list');
  if (!append) {
    state.activityCursor = null;
    list.replaceChildren(empty('Loading…'));
  }
  try {
    const { entries, nextCursor } = await api.adminActivity({ limit: 25, before: append ? state.activityCursor : null });
    if (!append) list.replaceChildren();
    if (!entries.length && !append) list.replaceChildren(empty('No activity events recorded.'));
    for (const entry of entries) {
      const actor = entry.actor ? `@${entry.actor.username} (${entry.actor.role})` : 'System or deleted staff account';
      const resource = entry.resourceType ? `${entry.resourceType}${entry.resourceId ? ` #${entry.resourceId}` : ''}` : null;
      list.append(el('div', { class: 'rounded-2xl border border-line/[var(--line-a)] p-3' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('span', { class: 'text-[14px] font-bold text-ink', text: entry.eventType }),
          pill(entry.outcome, entry.outcome === 'success' ? 'actioned' : 'dismissed'),
          el('span', { class: 'text-[13px] text-ink-faint', text: timeAgo(entry.createdAt) })
        ]),
        el('p', { class: 'mt-1 text-[13px] text-ink-soft', text: [actor, resource, entry.subjectUserId ? `user #${entry.subjectUserId}` : null, entry.source].filter(Boolean).join(' · ') })
      ]));
    }
    state.activityCursor = nextCursor;
    $('#activity-more').classList.toggle('hidden', !nextCursor);
  } catch (error) {
    if (!append) list.replaceChildren(empty(error.message || 'Could not load activity.'));
    $('#activity-more').classList.add('hidden');
  }
}

// ---------------------------------------------------------- health/settings

async function loadHealth() {
  const root = $('#health-body');
  root.replaceChildren(empty('Checking live service status…'));
  try {
    const health = await api.adminHealth();
    const items = Object.entries(health.checks || {}).map(([name, check]) => {
      let detail;
      if (name === 'database') detail = check.ok ? `Query responded in ${check.latencyMs} ms` : `Unavailable${check.code ? ` (${check.code})` : ''}`;
      else if (name === 'storage') detail = check.ok ? 'Upload storage is readable and writable' : 'Upload storage is not accessible';
      else if (name === 'deliveryQueue') detail = check.ok ? `${check.pending} pending · ${check.failed} failed` : `Queue status unavailable${check.code ? ` (${check.code})` : ''}`;
      else if (name === 'email' || name === 'sms') detail = `${check.configured ? 'Configured' : 'Not configured'} · provider reachability not probed`;
      else if (name === 'videoProcessing') detail = check.available ? 'FFmpeg available' : 'FFmpeg unavailable; generic poster fallback is supported';
      return [name, name === 'database' || name === 'storage' ? (check.ok ? 'OK' : 'Unavailable') : detail];
    });
    root.replaceChildren(
      statGroup('Overall', [['Status', health.status], ['Uptime seconds', health.uptimeSeconds], ['Checked at', new Date(health.checkedAt).toLocaleString()]]),
      statGroup('Live checks', items)
    );
  } catch (error) {
    root.replaceChildren(empty(error.message || 'Could not check system health.'));
  }
}

async function loadSettings() {
  const root = $('#settings-body');
  root.replaceChildren(empty('Loading runtime settings…'));
  try {
    const settings = await api.adminSettings();
    root.replaceChildren(
      statGroup('Retention policy', [
        ['Chat message hours', settings.retention.messageHours],
        ['Moments and posts hours', settings.retention.momentsAndPostsHours],
        ['Profile photos', settings.retention.profilePhotos],
        ['Verification evidence', settings.retention.verificationEvidence]
      ]),
      statGroup('Upload limits', [['Image maximum (MB)', settings.uploads.maxImageMb], ['Video maximum (MB)', settings.uploads.maxVideoMb]]),
      statGroup('Delivery and realtime', [
        ['Outbox queue', settings.delivery.queued ? 'Enabled' : 'Unavailable'],
        ['Email provider configured', statusText(settings.delivery.emailConfigured)],
        ['SMS provider configured', statusText(settings.delivery.smsConfigured)],
        ['TURN configured', statusText(settings.realtime.turnConfigured)]
      ]),
      statGroup('Operations', [
        ['Environment', settings.environment], ['Database TLS', statusText(settings.operations.databaseTls)],
        ['HTTPS redirect', statusText(settings.operations.forceHttps)], ['Trusted proxy', statusText(settings.operations.trustProxy)],
        ['Cleanup schedule', settings.operations.cleanupSchedule]
      ]),
      el('p', { class: 'rounded-2xl bg-surface-grey p-3 text-[13px] text-ink-soft', text: settings.editableInDashboard
        ? 'Settings can be changed here.'
        : 'These values are read-only and come from deployment environment variables. Secrets and infrastructure addresses are intentionally not shown.' })
    );
  } catch (error) {
    root.replaceChildren(empty(error.message || 'Could not load runtime settings.'));
  }
}

// --------------------------------------------------------------- tabs/boot

function showTab(name) {
  const tab = $$('[data-admin-tab]').find((button) => button.dataset.adminTab === name && !button.classList.contains('hidden'));
  if (!tab) return;
  state.tab = name;
  for (const button of $$('[data-admin-tab]')) {
    const active = button === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of $$('[data-admin-panel]')) panel.hidden = panel.dataset.adminPanel !== name;
  if (state.loaded.has(name)) return;
  state.loaded.add(name);
  if (name === 'queue') loadQueue();
  if (name === 'users') loadUsers();
  if (name === 'verification') loadVerifications();
  if (name === 'analytics') loadAnalytics();
  if (name === 'audit') loadAudit();
  if (name === 'activity') loadActivity();
  if (name === 'health') loadHealth();
  if (name === 'settings') loadSettings();
}

await bootPage({ socket: true, badges: true });

let whoami = null;
try {
  whoami = await api.adminWhoami();
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
}

if (!whoami) {
  $('#admin-denied').classList.remove('hidden');
} else {
  state.role = whoami.role;
  state.userId = Number(whoami.id);
  state.permissions = new Set(Array.isArray(whoami.permissions) ? whoami.permissions : []);
  $('#admin-body').classList.remove('hidden');
  const chip = $('#admin-role-chip');
  chip.textContent = whoami.role;
  chip.classList.remove('hidden');

  for (const button of $$('[data-admin-tab]')) {
    const permission = button.dataset.permission;
    if (permission && !can(permission)) button.classList.add('hidden');
    button.addEventListener('click', () => showTab(button.dataset.adminTab));
  }

  const visibleTabs = $$('[data-admin-tab]').filter((button) => !button.classList.contains('hidden'));
  if (visibleTabs.length) showTab(visibleTabs[0].dataset.adminTab);
  else $('#admin-denied').classList.remove('hidden');

  $('#queue-status').addEventListener('change', () => loadQueue());
  $('#queue-type').addEventListener('change', () => loadQueue());
  $('#queue-refresh').addEventListener('click', () => loadQueue());
  $('#queue-more').addEventListener('click', () => loadQueue(true));
  $('#user-search-form').addEventListener('submit', loadUsers);
  $('#user-status').addEventListener('change', () => loadUsers());
  $('#user-more').addEventListener('click', () => loadUsers(true));
  $('#verification-refresh').addEventListener('click', () => loadVerifications());
  $('#verification-more').addEventListener('click', () => loadVerifications(true));
  $('#audit-more').addEventListener('click', () => loadAudit(true));
  $('#activity-more').addEventListener('click', () => loadActivity(true));
  $('#health-refresh').addEventListener('click', loadHealth);
}
