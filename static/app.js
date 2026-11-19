/* Wedding Planner front end - plain JavaScript, no build step. */

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const money = p => GBP.format((p || 0) / 100);
const toPence = v => Math.round(parseFloat(String(v).replace(/[£,\s]/g, '') || '0') * 100);
const toPounds = p => ((p || 0) / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => { const d = new Date(); return iso(d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDate = s => s ? new Date(s + 'T00:00:00') : null;
const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  s ? parseDate(s).toLocaleDateString('en-GB', opts) : '—';
const daysUntil = s => Math.round((parseDate(s) - parseDate(todayISO())) / 86400000);

let S = null;               // app state from the server
let view = location.hash.slice(1) || 'overview';
let calMonth = null;        // Date for first of month shown on calendar
let showDone = false;       // checklist filter
let budgetFilter = '';      // category id filter
let guestFilter = '';
let countdownTimer = null;

/* ------------------------------------------------------------------ API */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  if (!r.ok) { const t = await r.text(); toast('Error: ' + t.replace(/<[^>]+>/g, '').slice(0, 140)); throw new Error(t); }
  return r.json();
}
async function load() { S = await api('GET', '/api/state'); applyPerPerson(); render(); }

// Per-person costs: total = price per person × how many guests it applies to (declined never count)
const BASIS = { day: 'day guests', day_yes: 'confirmed day guests', evening: 'evening guests', all: 'guests', custom: 'people' };
function headcount(basis, custom) {
  const live = S.guests.filter(g => g.rsvp !== 'Declined');
  if (basis === 'custom') return custom || 0;
  if (basis === 'day') return live.filter(g => g.invite !== 'Evening').length;
  if (basis === 'day_yes') return live.filter(g => g.invite !== 'Evening' && g.rsvp === 'Attending').length;
  if (basis === 'evening') return live.filter(g => g.invite !== 'Day').length;
  if (basis === 'all') return live.length;
  if (basis?.startsWith('dish:')) { const id = +basis.slice(5); return live.filter(g => [g.starter_id, g.main_id, g.dessert_id].includes(id)
    || S.guest_choices.some(c => c.guest_id === g.id && c.item_id === id)).length; }
  return 0;
}
function basisLabel(basis, n) {
  if (basis?.startsWith('dish:')) { const m = S.menu_items.find(x => x.id === +basis.slice(5)); return `choosing ${m ? m.name : 'a removed dish'}`; }
  const l = BASIS[basis] || 'people';
  return n === 1 ? l.replace(/s$/, '').replace('people', 'person') : l;
}
function applyPerPerson() {
  for (const e of S.expenses) if (e.pricing === 'person') {
    e.heads = headcount(e.per_basis, e.per_count);
    e.total = e.unit_price * e.heads;
  }
}
async function save(table, item, data) {
  if (item && item.id) await api('PUT', `/api/${table}/${item.id}`, data);
  else await api('POST', `/api/${table}`, data);
  await load();
}
async function remove(table, id) { await api('DELETE', `/api/${table}/${id}`); await load(); }

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ------------------------------------------------------------------ derived data */

const cat = id => S.categories.find(c => c.id === id);
const expense = id => S.expenses.find(e => e.id === id);

function expenseStats(e) {
  const pays = S.payments.filter(p => p.expense_id === e.id);
  const paid = pays.filter(p => p.paid).reduce((a, p) => a + p.amount, 0);
  const scheduled = pays.reduce((a, p) => a + p.amount, 0);
  return { pays, paid, scheduled, outstanding: Math.max(0, e.total - paid), unscheduled: Math.max(0, e.total - scheduled) };
}

// Everything still to pay with a date: unpaid payments, plus each cost's own deadline
// for any amount not covered by a scheduled payment (or a cost with no price yet).
function dueItems() {
  const items = S.payments.filter(p => !p.paid).map(p => {
    const e = expense(p.expense_id) || {};
    return { kind: 'pay', id: p.id, label: p.label, name: e.name, amount: p.amount, date: p.due_date };
  });
  for (const e of S.expenses) {
    if (!e.due_date || e.status === 'paid') continue;
    const st = expenseStats(e);
    if (e.total === 0 || st.unscheduled > 0)
      items.push({ kind: 'cost', id: e.id, label: e.total ? (st.scheduled ? 'Balance' : 'Payment') : 'Deadline',
        name: e.name, amount: st.unscheduled, date: e.due_date });
  }
  return items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

function totals() {
  let cost = 0, paid = 0;
  for (const e of S.expenses) { cost += e.total; paid += expenseStats(e).paid; }
  const budget = parseInt(S.settings.total_budget || '0', 10);
  return { cost, paid, outstanding: Math.max(0, cost - paid), budget, left: budget - cost };
}

function categoryStats() {
  return S.categories.map(c => {
    const exps = S.expenses.filter(e => e.category_id === c.id);
    const cost = exps.reduce((a, e) => a + e.total, 0);
    const paid = exps.reduce((a, e) => a + expenseStats(e).paid, 0);
    return { ...c, cost, paid, count: exps.length };
  });
}

function coupleName() {
  const a = (S.settings.partner1 || '').trim(), b = (S.settings.partner2 || '').trim();
  return a && b ? `${a} & ${b}` : (a || b || 'Our Wedding');
}

function weddingDateTime() {
  const t = S.settings.wedding_time || '12:00';
  return new Date(`${S.settings.wedding_date}T${t}:00`);
}

/* ------------------------------------------------------------------ modal form */

function openForm(title, fields, values, onSave, onDelete) {
  const dlg = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  const box = document.getElementById('modal-fields');
  box.innerHTML = fields.map(f => {
    const v = values[f.key] ?? f.default ?? '';
    const id = 'f_' + f.key;
    if (f.type === 'note') return `<p class="field wide form-note" data-key="${f.key}" id="${id}"></p>`;
    let input;
    if (f.type === 'select') {
      const opt = o => {
        if (o && o.group) return o.options.length ? `<optgroup label="${esc(o.group)}">${o.options.map(opt).join('')}</optgroup>` : '';
        const [val, lab] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(val)}" ${String(val ?? '') === String(v ?? '') ? 'selected' : ''}>${esc(lab)}</option>`;
      };
      input = `<select id="${id}">${f.options.map(opt).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" rows="3">${esc(v)}</textarea>`;
    } else if (f.type === 'checkbox') {
      return `<label class="check" data-key="${f.key}"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    } else if (f.type === 'money') {
      input = `<div class="money-input"><span>£</span><input id="${id}" inputmode="decimal" value="${esc(v === '' ? '' : toPounds(v))}"></div>`;
    } else {
      input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(v)}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">`;
    }
    return `<label class="field ${f.wide ? 'wide' : ''}" data-key="${f.key}"><span>${esc(f.label)}</span>${input}</label>`;
  }).join('');

  const current = () => Object.fromEntries(fields.filter(f => f.type !== 'note').map(f => {
    const el = document.getElementById('f_' + f.key);
    return [f.key, f.type === 'checkbox' ? el.checked : el.value];
  }));
  const refresh = () => {
    const v = current();
    for (const f of fields) {
      const wrap = box.querySelector(`[data-key="${f.key}"]`);
      if (f.when) wrap.hidden = !f.when(v);
      if (f.type === 'note' && !wrap.hidden) wrap.innerHTML = f.text(v);
    }
  };
  box.oninput = box.onchange = refresh;
  refresh();

  const del = document.getElementById('modal-delete');
  del.hidden = !onDelete;
  del.onclick = async () => { if (confirm('Delete this?')) { dlg.close(); await onDelete(); } };
  document.getElementById('modal-cancel').onclick = () => dlg.close();
  document.getElementById('modal-form').onsubmit = async ev => {
    ev.preventDefault();
    const out = {};
    for (const f of fields) {
      if (f.type === 'note') continue;
      const el = document.getElementById('f_' + f.key);
      if (f.type === 'checkbox') out[f.key] = el.checked ? 1 : 0;
      else if (f.type === 'money') out[f.key] = toPence(el.value);
      else out[f.key] = el.value;
    }
    dlg.close();
    await onSave(out);
  };
  dlg.showModal();
  const first = box.querySelector('input:not([type=checkbox]),select,textarea');
  if (first) first.focus();
}

const catOptions = (blank = 'None') => [['', blank], ...S.categories.map(c => [c.id, c.name])];

function editExpense(e = {}) {
  openForm(e.id ? 'Edit cost' : 'Add a cost', [
    { key: 'name', label: 'What is it?', required: true, placeholder: 'e.g. Photographer package' },
    { key: 'category_id', label: 'Category', type: 'select', options: catOptions('Uncategorised'), default: budgetFilter },
    { key: 'supplier', label: 'Supplier' },
    { key: 'contact', label: 'Contact (phone / email)' },
    { key: 'pricing', label: 'Priced', type: 'select', options: [['fixed', 'As a fixed total'], ['person', 'Per person']], default: 'fixed' },
    { key: 'total', label: 'Total cost', type: 'money', when: v => v.pricing !== 'person' },
    { key: 'unit_price', label: 'Price per person', type: 'money', when: v => v.pricing === 'person' },
    { key: 'per_basis', label: 'For each…', type: 'select', when: v => v.pricing === 'person', default: 'day', options: [
      ['day', 'Day guest (not declined)'], ['day_yes', 'Day guest who has said yes'], ['evening', 'Evening guest (not declined)'],
      ['all', 'Guest (not declined)'], ['custom', 'Person - I\'ll enter the number'],
      { group: 'Guest who chose…', options: S.menu_items.filter(m => (course(m.course) || {}).choose).map(m => [`dish:${m.id}`, `${m.name} (${courseName(m.course)})`]) }] },
    { key: 'per_count', label: 'Number of people', type: 'number', when: v => v.pricing === 'person' && v.per_basis === 'custom' },
    { key: 'calc', type: 'note', when: v => v.pricing === 'person', wide: true,
      text: v => { const n = headcount(v.per_basis, +v.per_count); const unit = toPence(v.unit_price);
        return `${money(unit)} × ${n} ${basisLabel(v.per_basis, n)} = <b>${money(unit * n)}</b>. This updates as your guest list changes.`; } },
    { key: 'due_date', label: 'Pay by / deadline', type: 'date' },
    { key: 'status', label: 'Status', type: 'select', options: [['idea', 'Idea'], ['quoted', 'Quoted'], ['booked', 'Booked'], ['paid', 'Paid in full']], default: 'quoted' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ], e, d => save('expenses', e, d), e.id ? () => remove('expenses', e.id) : null);
}

function editPayment(p = {}, expenseId) {
  openForm(p.id ? 'Edit payment' : 'Add a payment', [
    { key: 'expense_id', label: 'For', type: 'select', options: S.expenses.map(e => [e.id, e.name + (e.supplier ? ` (${e.supplier})` : '')]), default: expenseId },
    { key: 'label', label: 'Label', placeholder: 'Deposit / Instalment / Final balance', default: 'Deposit' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'paid', label: 'Paid', type: 'checkbox' },
    { key: 'paid_date', label: 'Date paid', type: 'date' },
    { key: 'method', label: 'Paid by', placeholder: 'Card / bank transfer / cash' },
  ], p, d => {
    if (d.paid && !d.paid_date) d.paid_date = todayISO();
    return save('payments', p, d);
  }, p.id ? () => remove('payments', p.id) : null);
}

function editTask(t = {}) {
  openForm(t.id ? 'Edit task' : 'Add a task', [
    { key: 'title', label: 'Task', required: true, wide: true },
    { key: 'due_date', label: 'Due', type: 'date' },
    { key: 'category_id', label: 'Category', type: 'select', options: catOptions() },
    { key: 'done', label: 'Done', type: 'checkbox' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ], t, d => save('tasks', t, d), t.id ? () => remove('tasks', t.id) : null);
}

function editCategory(c = {}) {
  openForm(c.id ? 'Edit category' : 'Add a category', [
    { key: 'name', label: 'Name', required: true },
    { key: 'budget', label: 'Budget for this category', type: 'money' },
    { key: 'colour', label: 'Colour', type: 'color', default: '#8a9a7b' },
    { key: 'sort', label: 'Sort order', type: 'number', default: S.categories.length },
  ], c, d => save('categories', c, d), c.id ? () => remove('categories', c.id) : null);
}

const INVITES = ['Day & Evening', 'Day', 'Evening'];
// 'To invite' = on the list but no invitation sent yet; 'Pending' = invited, awaiting a reply
const RSVPS = [['To invite', 'To invite'], ['Pending', 'Invited – pending'], ['Attending', 'Attending'], ['Declined', 'Declined']];
const invited = g => g.rsvp !== 'To invite';
let rsvpFilter = '';
// Courses: the four built-ins keep their choice on the guest (kids dishes count as the main);
// any course you add stores choices separately.
const BUILTIN_FIELD = { starter: 'starter_id', main: 'main_id', dessert: 'dessert_id', kids: 'main_id' };
const course = key => S.menu_courses.find(c => c.key === key);
const courseName = key => (course(key) || {}).name || key;
const customCourses = () => S.menu_courses.filter(c => !BUILTIN_FIELD[c.key]);
const dishes = key => S.menu_items.filter(m => m.course === key);
function choiceOf(g, key) {
  if (BUILTIN_FIELD[key]) return g[BUILTIN_FIELD[key]] || null;
  const c = S.guest_choices.find(x => x.guest_id === g.id && x.course_key === key);
  return c ? c.item_id : null;
}
const chose = (g, m) => choiceOf(g, m.course) === m.id;
const servingPool = c => S.guests.filter(g => g.rsvp !== 'Declined' && invited(g) && (c.serving === 'evening' ? g.invite !== 'Day' : g.invite !== 'Evening'));
const dish = id => S.menu_items.find(m => m.id === id);
const dishLabel = m => m.name + (m.dietary ? ` (${m.dietary})` : '');

function mealFields() {
  if (!S.menu_items.length)
    return [{ key: 'meal', label: 'Meal choice', placeholder: 'Set up your menu on the Food tab for drop-downs' }];
  const sel = (key, label, ck) => ({ key, label, type: 'select',
    options: [['', 'Not chosen'], ...dishes(ck).map(m => [m.id, dishLabel(m)]),
      ...(ck === 'main' && course('kids') ? [{ group: courseName('kids'), options: dishes('kids').map(m => [m.id, dishLabel(m)]) }] : [])] });
  const out = [];
  for (const c of S.menu_courses) {
    if (c.key === 'kids' || !c.choose) continue;
    const has = dishes(c.key).length || (c.key === 'main' && dishes('kids').length);
    if (has) out.push(sel(BUILTIN_FIELD[c.key] || `choice_${c.key}`, c.name, c.key));
  }
  return out;
}

const mealSummary = g => [g.starter_id, g.main_id, g.dessert_id, ...customCourses().map(c => choiceOf(g, c.key))]
  .map(dish).filter(Boolean).map(m => m.name).join(' · ') || g.meal || '';

const seatTable = id => S.seating_tables.find(t => t.id === id);
const tableName = g => (seatTable(g.table_id) || {}).name || g.table_no || '';

function editGuest(g = {}) {
  openForm(g.id ? 'Edit guest' : 'Add a guest', [
    { key: 'name', label: 'Name', required: true },
    { key: 'party', label: 'Group / side', placeholder: "e.g. Family, Work friends" },
    { key: 'invite', label: 'Invited to', type: 'select', options: INVITES, default: 'Day & Evening' },
    { key: 'rsvp', label: 'RSVP', type: 'select', options: RSVPS, default: 'To invite' },
    ...mealFields(),
    { key: 'dietary', label: 'Dietary needs' },
    { key: 'table_id', label: 'Table', type: 'select', options: [['', 'Not seated'], ...S.seating_tables.map(t => [t.id, t.name])] },
    { key: 'email', label: 'Email / phone' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ], { ...g, ...Object.fromEntries(customCourses().map(c => [`choice_${c.key}`, g.id ? choiceOf(g, c.key) ?? '' : ''])) },
  async d => {
    const choices = {};
    for (const k of Object.keys(d)) if (k.startsWith('choice_')) { choices[k.slice(7)] = d[k]; delete d[k]; }
    let id = g.id;
    if (id) await api('PUT', `/api/guests/${id}`, d); else id = (await api('POST', '/api/guests', d)).id;
    if (Object.keys(choices).length) await api('PUT', `/api/guests/${id}/choices`, choices);
    await load();
  }, g.id ? () => remove('guests', g.id) : null);
}

/* ------------------------------------------------------------------ views */

function render() {
  if (S.settings.setup_done !== '1' || wiz.step === WIZ_DONE) {
    document.body.classList.add('wizard-mode'); clearInterval(countdownTimer); return renderWizard();
  }
  document.body.classList.remove('wizard-mode');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  document.getElementById('brand-name').textContent = coupleName();
  clearInterval(countdownTimer);
  const el = document.getElementById('view');
  el.innerHTML = ({ overview, budget, calendar, checklist, guests, seating, food, settings }[view] || overview)();
  if (view === 'overview') startCountdown();
}

function hero(compact = false) {
  const w = weddingDateTime();
  const dateStr = w.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `
  <section class="hero ${compact ? 'compact' : ''}" style="background-image:linear-gradient(180deg,rgba(30,28,24,.25),rgba(30,28,24,.65)),${S.settings.hero_image ? `url('${esc(S.settings.hero_image)}')` : 'linear-gradient(135deg,#7b8f6a,#b8954f)'}">
    <div class="hero-inner">
      ${S.settings.venue_name ? `<div class="eyebrow">${esc(S.settings.venue_name)}</div>` : ''}
      <h1>${esc(coupleName()).replace(' &amp; ', ' <span class="amp">&amp;</span> ')}</h1>
      <div class="hero-date">${dateStr}${S.settings.wedding_time ? ' · ' + esc(S.settings.wedding_time) : ''}</div>
      <div class="countdown" id="countdown"></div>
    </div>
  </section>`;
}

function startCountdown() {
  const el = document.getElementById('countdown');
  if (!el) return;
  const target = weddingDateTime();
  const tick = () => {
    let diff = target - new Date();
    if (diff <= 0) { el.innerHTML = '<div class="married">Just married! 🎉</div>'; return; }
    const d = Math.floor(diff / 86400000); diff -= d * 86400000;
    const h = Math.floor(diff / 3600000); diff -= h * 3600000;
    const m = Math.floor(diff / 60000); diff -= m * 60000;
    const s = Math.floor(diff / 1000);
    el.innerHTML = [[d, 'days'], [h, 'hours'], [m, 'mins'], [s, 'secs']]
      .map(([n, l]) => `<div><b>${String(n).padStart(l === 'days' ? 1 : 2, '0')}</b><span>${l}</span></div>`).join('');
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function statCards() {
  const t = totals();
  const pct = t.cost ? Math.round(t.paid / t.cost * 100) : 0;
  return `
  <div class="stats">
    <div class="stat"><span>Total cost</span><b>${money(t.cost)}</b><small>${S.expenses.length} item${S.expenses.length === 1 ? '' : 's'}</small></div>
    <div class="stat good"><span>Paid so far</span><b>${money(t.paid)}</b><small>${pct}% of total</small></div>
    <div class="stat warn"><span>Still to pay</span><b>${money(t.outstanding)}</b><small>${(n => `${n} payment${n === 1 ? '' : 's'} or deadline${n === 1 ? '' : 's'} due`)(dueItems().length)}</small></div>
    <div class="stat ${t.budget && t.left < 0 ? 'bad' : ''}"><span>Budget left</span><b>${t.budget ? money(t.left) : '—'}</b>
      <small>${t.budget ? 'of ' + money(t.budget) : '<a href="#settings">Set a budget</a>'}</small></div>
  </div>
  <div class="progress" title="${pct}% paid"><div style="width:${pct}%"></div></div>`;
}

function dueBadge(date, done) {
  if (!date || done) return '';
  const n = daysUntil(date);
  if (n < 0) return `<span class="badge bad">${-n}d overdue</span>`;
  if (n === 0) return `<span class="badge warn">today</span>`;
  if (n <= 14) return `<span class="badge warn">in ${n}d</span>`;
  return '';
}

function overview() {
  const upcomingPays = dueItems().slice(0, 6);
  const upcomingTasks = S.tasks.filter(t => !t.done && t.due_date).slice(0, 7);
  const done = S.tasks.filter(t => t.done).length;
  const cs = categoryStats().filter(c => c.cost || c.budget).sort((a, b) => b.cost - a.cost);
  const maxCat = Math.max(1, ...cs.map(c => Math.max(c.cost, c.budget)));
  const g = guestCounts();
  return `
  ${hero()}
  <div class="container">
    ${statCards()}
    <div class="grid2">
      <section class="card">
        <div class="card-head"><h2>Payments & deadlines</h2><a class="link" href="#budget">Budget →</a></div>
        ${upcomingPays.length ? `<ul class="list">${upcomingPays.map(i => `<li>
            <button class="tick" ${i.kind === 'pay' ? `data-pay="${i.id}"` : `data-cost="${i.id}"`} title="Mark paid"></button>
            <div class="grow" ${i.kind === 'pay' ? `data-edit-pay="${i.id}"` : `data-edit-exp="${i.id}"`}><b>${esc(i.label)}</b> · ${esc(i.name)}
              <small>${i.date ? fmtDate(i.date) : 'No date'} ${dueBadge(i.date)}</small></div>
            <b>${i.amount ? money(i.amount) : '<span class="muted">£ —</span>'}</b></li>`).join('')}</ul>`
          : '<p class="muted">Nothing due. Add a cost with a deadline or a payment schedule in the Budget tab.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Coming up</h2><a class="link" href="#checklist">Checklist →</a></div>
        <ul class="list">${upcomingTasks.map(taskRow).join('') || '<li class="muted">All done!</li>'}</ul>
        <small class="muted">${done} of ${S.tasks.length} tasks done</small>
      </section>
    </div>
    <div class="grid2">
      <section class="card">
        <div class="card-head"><h2>Spend by category</h2></div>
        ${cs.length ? cs.map(c => `
          <div class="catbar">
            <div class="catbar-label"><span class="dot" style="background:${esc(c.colour)}"></span>${esc(c.name)}
              <span class="muted">${money(c.cost)}${c.budget ? ' / ' + money(c.budget) : ''}</span></div>
            <div class="bar"><div style="width:${c.cost / maxCat * 100}%;background:${esc(c.colour)}"></div>
              ${c.budget ? `<i style="left:${c.budget / maxCat * 100}%" title="Budget"></i>` : ''}</div>
          </div>`).join('') : '<p class="muted">Add costs to see where the money goes.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Guests</h2><a class="link" href="#guests">Guests →</a></div>
        <div class="mini-stats">
          <div><b>${g.total}</b><span>invited</span></div>
          <div><b>${g.yes}</b><span>attending</span></div>
          <div><b>${g.no}</b><span>declined</span></div>
          <div><b>${g.pending}</b><span>awaiting</span></div>
        </div>
        <p class="muted">${g.day} day guests · ${g.evening} evening guests${g.toInvite ? ` · <b>${g.toInvite}</b> still to invite` : ''}</p>
      </section>
    </div>
  </div>`;
}

function taskRow(t) {
  const c = cat(t.category_id);
  return `<li class="${t.done ? 'done' : ''}">
    <button class="tick ${t.done ? 'on' : ''}" data-task="${t.id}" title="Toggle done"></button>
    <div class="grow" data-edit-task="${t.id}">${esc(t.title)}
      <small>${fmtDate(t.due_date)} ${dueBadge(t.due_date, t.done)} ${c ? `<span class="chip" style="--c:${esc(c.colour)}">${esc(c.name)}</span>` : ''}</small></div>
  </li>`;
}

function budget() {
  const cats = categoryStats();
  const groups = [...cats.map(c => ({ c, items: S.expenses.filter(e => e.category_id === c.id) })),
    { c: { id: null, name: 'Uncategorised', colour: '#999', budget: 0 }, items: S.expenses.filter(e => !cat(e.category_id)) }]
    .filter(gp => (budgetFilter === '' || String(gp.c.id) === String(budgetFilter)) && (gp.items.length || (budgetFilter !== '' && gp.c.id)));
  return `
  <div class="container">
    <div class="page-head"><h1>Budget</h1>
      <div class="actions">
        <select id="budget-filter"><option value="">All categories</option>
          ${S.categories.map(c => `<option value="${c.id}" ${String(c.id) === String(budgetFilter) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <button class="btn" id="add-payment" ${S.expenses.length ? '' : 'disabled'}>+ Payment</button>
        <button class="btn primary" id="add-expense">+ Cost</button>
      </div></div>
    ${statCards()}
    ${groups.map(({ c, items }) => {
      const cost = items.reduce((a, e) => a + e.total, 0);
      return `<section class="card">
        <div class="card-head"><h2><span class="dot" style="background:${esc(c.colour)}"></span>${esc(c.name)}</h2>
          <span class="muted">${money(cost)}${c.budget ? ' of ' + money(c.budget) + ' budget' : ''}
          ${c.budget && cost > c.budget ? '<span class="badge bad">over</span>' : ''}</span></div>
        ${items.length ? items.map(expenseBlock).join('') : '<p class="muted">Nothing here yet.</p>'}
      </section>`;
    }).join('') || '<p class="muted">No costs yet. Click “+ Cost”.</p>'}
    <section class="card">
      <div class="card-head"><h2>Categories & Budgets</h2><button class="btn small" id="add-category">+ Category</button></div>
      <table class="table"><thead><tr><th class="handle-col"></th><th>Category</th><th class="r">Budget</th><th class="r">Committed</th><th class="r">Paid</th><th class="r">Left</th></tr></thead>
      <tbody id="cat-rows">${cats.map(c => `<tr class="clickable" data-edit-cat="${c.id}" data-cat-id="${c.id}">
        <td class="handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</td>
        <td><span class="dot" style="background:${esc(c.colour)}"></span>${esc(c.name)}</td>
        <td class="r">${c.budget ? money(c.budget) : '—'}</td><td class="r">${money(c.cost)}</td><td class="r">${money(c.paid)}</td>
        <td class="r ${c.budget && c.budget - c.cost < 0 ? 'neg' : ''}">${c.budget ? money(c.budget - c.cost) : '—'}</td></tr>`).join('')}
      </tbody></table>
      <small class="muted">Drag ⠿ to reorder. Click a category to set its budget, colour or name.</small>
    </section>
  </div>`;
}

const STATUS = { idea: 'Idea', quoted: 'Quoted', booked: 'Booked', paid: 'Paid in full' };

function expenseBlock(e) {
  const st = expenseStats(e);
  return `<div class="expense">
    <div class="expense-main" data-edit-exp="${e.id}">
      <div class="grow"><b>${esc(e.name)}</b> <span class="badge s-${esc(e.status)}">${STATUS[e.status] || esc(e.status)}</span>
        <small>${esc(e.supplier)}${e.contact ? ' · ' + esc(e.contact) : ''}</small>
        ${e.pricing === 'person' ? `<small class="per">${money(e.unit_price)} per person × ${e.heads} ${basisLabel(e.per_basis, e.heads)}</small>` : ''}</div>
      <div class="nums"><div><span>Total</span>${money(e.total)}</div><div><span>Paid</span>${money(st.paid)}</div>
        <div class="${st.outstanding ? 'owe' : ''}"><span>To pay</span>${money(st.outstanding)}</div></div>
    </div>
    <ul class="payments">
      ${st.pays.map(p => `<li class="${p.paid ? 'done' : ''}">
        <button class="tick ${p.paid ? 'on' : ''}" data-pay="${p.id}"></button>
        <span class="grow" data-edit-pay="${p.id}">${esc(p.label)} · ${p.paid ? 'paid ' + fmtDate(p.paid_date) : 'due ' + fmtDate(p.due_date)} ${p.paid ? '' : dueBadge(p.due_date)}
          ${p.method ? `<small class="muted">${esc(p.method)}</small>` : ''}</span>
        <b>${money(p.amount)}</b></li>`).join('')}
      ${e.status !== 'paid' && e.due_date && (st.unscheduled || !e.total)
        ? `<li><button class="tick" data-cost="${e.id}" title="Mark paid"></button>
            <span class="grow" data-edit-exp="${e.id}">${e.total ? (st.scheduled ? 'Balance' : 'Payment') : 'Deadline'} · due ${fmtDate(e.due_date)} ${dueBadge(e.due_date)}</span>
            <b>${e.total ? money(st.unscheduled) : ''}</b></li>`
        : st.unscheduled && e.total ? `<li class="muted"><span class="grow">${money(st.unscheduled)} not yet scheduled</span></li>` : ''}
      <li><button class="link" data-add-pay="${e.id}">+ add payment</button></li>
    </ul>
  </div>`;
}

function calendar() {
  if (!calMonth) { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(y, m, 1 - startOffset);
  const events = {};
  const add = (d, ev) => { if (d) (events[d] ||= []).push(ev); };
  add(S.settings.wedding_date, { cls: 'wedding', text: '💍 Wedding day' });
  S.tasks.forEach(t => add(t.due_date, { cls: 'task' + (t.done ? ' done' : ''), text: t.title, task: t.id }));
  S.payments.forEach(p => add(p.paid ? p.paid_date || p.due_date : p.due_date,
    { cls: 'pay' + (p.paid ? ' done' : ''), text: `${money(p.amount)} ${p.label} – ${(expense(p.expense_id) || {}).name || ''}`, pay: p.id }));
  dueItems().filter(i => i.kind === 'cost').forEach(i => add(i.date,
    { cls: 'pay', text: `${i.amount ? money(i.amount) + ' ' : ''}${i.label} – ${i.name}`, exp: i.id }));
  const today = todayISO();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = iso(d);
    const evs = events[key] || [];
    cells += `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${key === today ? 'today' : ''} ${key === S.settings.wedding_date ? 'wday' : ''}">
      <div class="num">${d.getDate()}</div>
      ${evs.map(ev => `<div class="ev ${ev.cls}" ${ev.task ? `data-edit-task="${ev.task}"` : ''} ${ev.pay ? `data-edit-pay="${ev.pay}"` : ''} ${ev.exp ? `data-edit-exp="${ev.exp}"` : ''} title="${esc(ev.text)}">${esc(ev.text)}</div>`).join('')}
    </div>`;
    if (i >= 34 && d.getMonth() !== m && d.getDay() === 0) break;
  }
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const agenda = Object.keys(events).filter(k => k.startsWith(monthKey)).sort()
    .flatMap(k => events[k].map(ev => ({ k, ...ev })));
  return `
  <div class="container">
    <div class="page-head"><h1>${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h1>
      <div class="actions">
        <button class="btn" data-cal="-1">‹</button><button class="btn" data-cal="0">Today</button>
        <button class="btn" data-cal="1">›</button><button class="btn" data-cal="w">💍 Wedding month</button>
        <button class="btn primary" id="add-task">+ Task</button>
      </div></div>
    <div class="legend"><span class="ev task">Task</span><span class="ev pay">Payment due</span><span class="ev wedding">Wedding</span></div>
    <div class="cal">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <section class="card agenda">
      <h2>This month</h2>
      ${agenda.length ? `<ul class="list">${agenda.map(a => `<li><span class="date">${fmtDate(a.k, { day: 'numeric', month: 'short' })}</span>
        <span class="ev ${a.cls}" ${a.task ? `data-edit-task="${a.task}"` : ''} ${a.pay ? `data-edit-pay="${a.pay}"` : ''} ${a.exp ? `data-edit-exp="${a.exp}"` : ''}>${esc(a.text)}</span></li>`).join('')}</ul>`
        : '<p class="muted">Nothing this month.</p>'}
    </section>
    <section class="card">
      <h2>Add to your phone's calendar</h2>
      <p>Subscribe to this link in Google Calendar, Outlook or Apple Calendar to see tasks and payment due dates there too:</p>
      <div class="copy"><input readonly id="ics" value="${esc(location.origin + S.ics_url)}"><button class="btn" id="copy-ics">Copy</button></div>
      <small class="muted">Your phone must be able to reach this server (e.g. over a VPN such as Tailscale).</small>
    </section>
  </div>`;
}

function checklist() {
  const tasks = S.tasks.filter(t => showDone || !t.done);
  const today = todayISO();
  const overdue = tasks.filter(t => !t.done && t.due_date && t.due_date < today);
  const rest = tasks.filter(t => !overdue.includes(t));
  const groups = {};
  rest.forEach(t => {
    const k = t.due_date ? t.due_date.slice(0, 7) : 'zzzz';
    (groups[k] ||= []).push(t);
  });
  const done = S.tasks.filter(t => t.done).length;
  const pct = S.tasks.length ? Math.round(done / S.tasks.length * 100) : 0;
  return `
  <div class="container">
    <div class="page-head"><h1>Checklist</h1>
      <div class="actions">
        <label class="check"><input type="checkbox" id="show-done" ${showDone ? 'checked' : ''}> Show completed</label>
        <button class="btn primary" id="add-task">+ Task</button></div></div>
    <div class="progress-label">${done} of ${S.tasks.length} done (${pct}%)</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    ${overdue.length ? `<section class="card overdue"><h2>Overdue</h2><ul class="list">${overdue.map(taskRow).join('')}</ul></section>` : ''}
    ${Object.keys(groups).sort().map(k => `<section class="card"><h2>${k === 'zzzz' ? 'No date' :
      new Date(k + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2>
      <ul class="list">${groups[k].map(taskRow).join('')}</ul></section>`).join('')}
  </div>`;
}

function guestCounts() {
  const g = S.guests.filter(invited);
  return {
    toInvite: S.guests.length - g.length, total: g.length, yes: g.filter(x => x.rsvp === 'Attending').length, no: g.filter(x => x.rsvp === 'Declined').length,
    pending: g.filter(x => x.rsvp === 'Pending').length, day: g.filter(x => x.invite !== 'Evening').length,
    evening: g.filter(x => x.invite !== 'Day').length,
  };
}

function guests() {
  const c = guestCounts();
  const q = guestFilter.toLowerCase();
  const list = S.guests.filter(g => (!rsvpFilter || g.rsvp === rsvpFilter)
    && (!q || [g.name, g.party, tableName(g), g.dietary].join(' ').toLowerCase().includes(q)));
  const dietary = S.guests.filter(g => g.dietary && g.rsvp !== 'Declined');
  return `
  <div class="container">
    <div class="page-head"><h1>Guests</h1>
      <div class="actions"><input id="guest-search" placeholder="Search…" value="${esc(guestFilter)}">
        <label class="btn">Import CSV<input type="file" id="import-guests" accept=".csv,text/csv" hidden></label>
        <button class="btn" id="export-guests">Export CSV</button>
        <button class="btn primary" id="add-guest">+ Guest</button></div></div>
    <div class="stats five">
      <div class="stat"><span>Invited</span><b>${c.total}</b><small>${c.day} day · ${c.evening} evening</small></div>
      <div class="stat muted-stat"><span>To invite</span><b>${c.toInvite}</b>
        <small>${c.toInvite ? '<button class="link" id="mark-invited">Mark all as invited</button>' : 'Everyone has been invited'}</small></div>
      <div class="stat good"><span>Attending</span><b>${c.yes}</b></div>
      <div class="stat bad"><span>Declined</span><b>${c.no}</b></div>
      <div class="stat warn"><span>Awaiting reply</span><b>${c.pending}</b></div>
    </div>
    <div class="filters">${[['', `All (${S.guests.length})`], ...RSVPS.map(([v, l]) => [v, `${l} (${S.guests.filter(g => g.rsvp === v).length})`])]
      .map(([v, l]) => `<button class="pick ${rsvpFilter === v ? 'on' : ''}" style="--c:var(--sage)" data-rsvp-filter="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    <section class="card">
      <table class="table guests"><thead><tr><th>Name</th><th>Group</th><th>Invite</th><th>RSVP</th><th>Meal</th><th>Dietary</th><th>Table</th></tr></thead>
      <tbody>${list.map(g => `<tr>
        <td class="clickable" data-edit-guest="${g.id}"><b>${esc(g.name)}</b></td><td>${esc(g.party)}</td><td>${esc(g.invite)}</td>
        <td><select class="rsvp r-${esc(g.rsvp)}" data-rsvp="${g.id}">${RSVPS.map(([v, l]) => `<option value="${v}" ${v === g.rsvp ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td>${esc(mealSummary(g))}</td><td>${esc(g.dietary)}</td><td>${esc(tableName(g))}</td></tr>`).join('') ||
        `<tr><td colspan="7" class="muted">${S.guests.length ? 'No guests match.' : 'No guests yet.'}</td></tr>`}</tbody></table>
    </section>
    ${dietary.length ? `<section class="card"><h2>Dietary needs (for the caterer)</h2><ul class="list">${dietary.map(g =>
      `<li><b>${esc(g.name)}</b><span class="grow">&nbsp;– ${esc(g.dietary)}</span></li>`).join('')}</ul></section>` : ''}
  </div>`;
}

function settings() {
  const s = S.settings;
  return `
  ${hero(true)}
  <div class="container narrow">
    <section class="card">
      <h2>The big day</h2>
      <form id="settings-form" class="form-grid">
        <label class="field"><span>Partner 1</span><input name="partner1" value="${esc(s.partner1)}"></label>
        <label class="field"><span>Partner 2</span><input name="partner2" value="${esc(s.partner2)}"></label>
        <label class="field"><span>Wedding date</span><input type="date" name="wedding_date" value="${esc(s.wedding_date)}"></label>
        <label class="field"><span>Ceremony time</span><input type="time" name="wedding_time" value="${esc(s.wedding_time)}"></label>
        <label class="field"><span>Venue</span><input name="venue_name" value="${esc(s.venue_name)}"></label>
        <label class="field"><span>Venue website</span><input name="venue_url" value="${esc(s.venue_url)}"></label>
        <label class="field"><span>Total budget</span><div class="money-input"><span>£</span><input name="total_budget" inputmode="decimal" value="${toPounds(parseInt(s.total_budget || '0', 10))}"></div></label>
        <label class="field wide"><span>Header image (web address, or upload one below)</span><input name="hero_image" value="${esc(s.hero_image)}"></label>
        <div class="field wide"><button class="btn primary" type="submit">Save</button></div>
      </form>
    </section>
    <section class="card">
      <h2>Upload your own header photo</h2>
      <p class="muted">Upload a photo of the venue (or the two of you). It's stored on your server, so it won't break if the venue's website changes.</p>
      <div class="actions"><input type="file" id="hero-file" accept="image/*">
        ${s.venue_url ? '<button class="btn" id="venue-photo">Get photo from venue website</button>' : ''}</div>
    </section>
    <section class="card">
      <h2>Backup</h2>
      <p class="muted">Download everything as a single file, or restore from one. The database also lives in your data folder.</p>
      <div class="actions"><a class="btn" href="/api/export">Download backup</a>
        <label class="btn">Restore from backup<input type="file" id="import-file" accept=".json" hidden></label></div>
    </section>
    ${S.has_examples ? `<section class="card"><h2>Example data</h2>
      <p class="muted">Your planner still has the example costs or guests from setup.</p>
      <button class="btn danger" id="remove-examples">Remove all example data</button></section>` : ''}
    <section class="card">
      <h2>Password</h2>
      ${S.password_from_env
        ? `<p class="muted">The password is set by <code>APP_PASSWORD</code> in your Docker config. Remove that line and redeploy to manage it here instead.</p>`
        : `<p class="muted">${S.password_enabled
            ? 'A password is needed to open the planner. Share it with anyone who should have access. Each device stays signed in for 90 days.'
            : 'No password is set, so anyone who can reach this server on your network can view and edit your plans.'}</p>
          <div class="copy"><input type="password" id="new-password" placeholder="${S.password_enabled ? 'New password' : 'Choose a password'}" autocomplete="new-password">
            <button class="btn primary" id="set-password">${S.password_enabled ? 'Change' : 'Turn on'}</button></div>
          ${S.password_enabled ? '<button class="btn danger" id="remove-password">Remove password</button>' : ''}`}
      ${S.password_enabled ? '<a class="btn" href="/logout">Sign out</a>' : ''}
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ events */

document.getElementById('nav').addEventListener('click', e => {
  const a = e.target.closest('a[data-view]');
  if (a) { location.hash = a.dataset.view; }
});
window.addEventListener('hashchange', () => { view = location.hash.slice(1) || 'overview'; render(); window.scrollTo(0, 0); });

document.getElementById('view').addEventListener('click', async e => {
  if (e.target.closest('.handle')) return;
  if (view === 'food') {
    const ed = e.target.closest('[data-edit-dish]'), ad = e.target.closest('[data-add-dish]');
    const ec = e.target.closest('[data-edit-course]');
    if (ec) return editCourse(S.menu_courses.find(c => c.id === +ec.dataset.editCourse));
    if (ed) return editDish(dish(+ed.dataset.editDish));
    if (ad) return editDish({}, ad.dataset.addDish);
    if (e.target.id === 'add-dish') return editDish();
    if (e.target.id === 'add-course') return editCourse();
    if (e.target.id === 'export-caterer') return exportCaterer();
    return;
  }
  if (view === 'seating') {
    const ed = e.target.closest('[data-edit-table]'), un = e.target.closest('[data-unseat]');
    if (ed) return editTable(seatTable(+ed.dataset.editTable));
    if (un) return seatGuest(+un.dataset.unseat, null);
    if (e.target.id === 'add-table') return editTable();
    const tb = e.target.closest('.stable');
    if (selectedGuest && tb && !e.target.closest('.gchip')) return seatGuest(selectedGuest, +tb.dataset.table);
    if (selectedGuest && e.target.closest('[data-drop-unseat]') && !e.target.closest('.gchip')) { selectedGuest = null; return render(); }
    return;
  }
  const rf = e.target.closest('[data-rsvp-filter]');
  if (rf) { rsvpFilter = rf.dataset.rsvpFilter; return render(); }
  const t = e.target.closest('[data-cost],[data-pay],[data-task],[data-edit-task],[data-edit-pay],[data-edit-exp],[data-add-pay],[data-edit-cat],[data-edit-guest],[data-cal],button[id],a.link');
  if (!t) return;
  const d = t.dataset;
  if (t.classList.contains('tick') && d.cost) {
    const ex = expense(+d.cost), st = expenseStats(ex);
    if (ex.total && st.unscheduled)
      await api('POST', '/api/payments', { expense_id: ex.id, label: st.scheduled ? 'Balance' : 'Paid in full',
        amount: st.unscheduled, due_date: ex.due_date, paid: 1, paid_date: todayISO() });
    else await api('PUT', `/api/expenses/${ex.id}`, { status: 'paid' });
    toast('Marked as paid'); return load();
  }
  if (t.classList.contains('tick') && d.pay) {
    const p = S.payments.find(x => x.id == d.pay);
    return save('payments', p, { paid: p.paid ? 0 : 1, paid_date: p.paid ? '' : todayISO() });
  }
  if (t.classList.contains('tick') && d.task) {
    const tk = S.tasks.find(x => x.id == d.task);
    return save('tasks', tk, { done: tk.done ? 0 : 1 });
  }
  if (d.editTask) return editTask(S.tasks.find(x => x.id == d.editTask));
  if (d.editPay) return editPayment(S.payments.find(x => x.id == d.editPay));
  if (d.editExp) return editExpense(S.expenses.find(x => x.id == d.editExp));
  if (d.addPay) return editPayment({}, +d.addPay);
  if (d.editCat) return editCategory(S.categories.find(x => x.id == d.editCat));
  if (d.editGuest) return editGuest(S.guests.find(x => x.id == d.editGuest));
  if (d.cal) {
    if (d.cal === '0') { const n = new Date(); calMonth = new Date(n.getFullYear(), n.getMonth(), 1); }
    else if (d.cal === 'w') { const w = parseDate(S.settings.wedding_date); calMonth = new Date(w.getFullYear(), w.getMonth(), 1); }
    else calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + (+d.cal), 1);
    return render();
  }
  switch (t.id) {
    case 'add-expense': return editExpense();
    case 'add-payment': return editPayment();
    case 'add-task': return editTask();
    case 'add-category': return editCategory();
    case 'add-guest': return editGuest();
    case 'copy-ics': navigator.clipboard?.writeText(document.getElementById('ics').value); return toast('Copied');
    case 'export-guests': return exportGuests();
    case 'mark-invited': {
      const todo = S.guests.filter(g => g.rsvp === 'To invite');
      if (!confirm(`Mark ${todo.length} guest${todo.length === 1 ? '' : 's'} as invited (awaiting reply)?`)) return;
      await api('POST', '/api/guests/mark-invited'); toast(`${todo.length} marked as invited`); return load();
    }
    case 'set-password': {
      const pw = document.getElementById('new-password').value;
      if (pw.length < 4) return toast('Use at least 4 characters');
      await api('POST', '/api/password', { password: pw }); toast('Password saved'); return load();
    }
    case 'remove-examples':
      if (!confirm('Remove all example costs, payments and guests?')) return;
      await api('DELETE', '/api/examples'); toast('Examples removed'); return load();
    case 'remove-password':
      if (!confirm('Remove the password? Anyone on your network will be able to open the planner.')) return;
      await api('POST', '/api/password', { password: '' }); toast('Password removed'); return load();
    case 'venue-photo': {
      t.disabled = true; t.textContent = 'Looking…';
      const r = await api('POST', '/api/venue-photo', { url: S.settings.venue_url });
      toast(r.ok ? 'Header photo updated' : r.error); return load();
    }
  }
});

document.getElementById('view').addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'budget-filter') { budgetFilter = t.value; return render(); }
  if (t.id === 'import-guests' && t.files[0]) { const f = t.files[0]; t.value = ''; return importGuests(f); }
  if (t.id === 'seat-evening') { seatEvening = t.checked; return render(); }
  if (t.id === 'show-done') { showDone = t.checked; return render(); }
  if (t.dataset.rsvp) return save('guests', { id: +t.dataset.rsvp }, { rsvp: t.value });
  if (t.id === 'hero-file' && t.files[0]) {
    const fd = new FormData(); fd.append('file', t.files[0]);
    await api('POST', '/api/hero', fd); toast('Header photo updated'); return load();
  }
  if (t.id === 'import-file' && t.files[0]) {
    if (!confirm('This replaces ALL current data with the backup. Continue?')) return;
    const data = JSON.parse(await t.files[0].text());
    await api('POST', '/api/import', data); toast('Backup restored'); return load();
  }
});

document.getElementById('view').addEventListener('input', e => {
  if (e.target.id === 'guest-search') {
    guestFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const s = document.getElementById('guest-search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});

document.getElementById('view').addEventListener('submit', async e => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.total_budget = String(toPence(data.total_budget));
  const oldDate = S.settings.wedding_date;
  await api('PUT', '/api/settings', data);
  if (data.wedding_date && oldDate && data.wedding_date !== oldDate && S.tasks.some(t => !t.done)) {
    const days = Math.round((parseDate(data.wedding_date) - parseDate(oldDate)) / 86400000);
    if (confirm(`The wedding date moved by ${days} days. Move the unfinished checklist tasks by the same amount?`))
      await api('POST', '/api/shift-tasks', { days });
  }
  toast('Saved'); load();
});

document.getElementById('view').addEventListener('pointerdown', e => {
  const handle = e.target.closest('.handle');
  if (!handle) return;
  e.preventDefault();
  const row = handle.closest('tr'), body = row.parentElement;
  row.classList.add('dragging');
  const move = ev => {
    if (ev.clientY < 70) window.scrollBy(0, -12);
    else if (ev.clientY > innerHeight - 70) window.scrollBy(0, 12);
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#cat-rows tr');
    if (!over || over === row) return;
    const r = over.getBoundingClientRect();
    body.insertBefore(row, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    row.classList.remove('dragging');
    const ids = [...body.querySelectorAll('tr')].map(tr => +tr.dataset.catId);
    if (ids.join() !== S.categories.map(c => c.id).join()) {
      await api('POST', '/api/categories/order', { ids }); await load();
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
});

function exportGuests() {
  const cols = [['Name', 'name'], ['Group', 'party'], ['Invite', 'invite'], ['RSVP', 'rsvp'],
    ['Starter', g => (dish(g.starter_id) || {}).name], ['Main', g => (dish(g.main_id) || {}).name || g.meal],
    ['Dessert', g => (dish(g.dessert_id) || {}).name],
    ...customCourses().filter(c => c.choose).map(c => [c.name, g => (dish(choiceOf(g, c.key)) || {}).name]),
    ['Dietary', 'dietary'], ['Table', g => tableName(g)], ['Email / phone', 'email'], ['Notes', 'notes']];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(c => c[0]).join(','),
    ...S.guests.map(g => cols.map(([, k]) => cell(typeof k === 'function' ? k(g) : g[k])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'guest-list.csv'; a.click();
}

// --- CSV import: handles quotes, commas/semicolons, Excel BOM and flexible headings
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';'
              : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}

const GUEST_HEADINGS = {
  name: ['name', 'full name', 'guest', 'guest name', 'guests'],
  first: ['first name', 'firstname', 'forename', 'given name'],
  last: ['last name', 'lastname', 'surname', 'family name'],
  party: ['group', 'side', 'party', 'relationship', 'category', 'household'],
  invite: ['invite', 'invited to', 'invitation', 'type', 'day/evening', 'day or evening'],
  rsvp: ['rsvp', 'status', 'attending', 'response', 'reply'],
  starter: ['starter', 'starters', 'first course'],
  main: ['main', 'mains', 'main course', 'meal', 'meal choice', 'menu', 'food', 'kids meal'],
  dessert: ['dessert', 'desserts', 'pudding', 'sweet'],
  dietary: ['dietary', 'diet', 'dietary requirements', 'dietary needs', 'allergies', 'allergy'],
  table: ['table', 'table no', 'table number', 'table name'],
  email: ['email', 'e-mail', 'phone', 'contact', 'email / phone', 'mobile'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

function rowsToGuests(rows) {
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(GUEST_HEADINGS)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  const hasHeader = 'name' in col || 'first' in col;
  if (!hasHeader) col.name = 0;              // no recognisable headings: first column is the name
  const body = hasHeader ? rows.slice(1) : rows;
  const get = (r, k) => (k in col ? (r[col[k]] || '').trim() : '');
  const custom = customCourses().filter(c => c.choose)
    .map(c => [c.name, head.indexOf(c.name.trim().toLowerCase())]).filter(([, i]) => i >= 0);
  return body.map(r => {
    const g = { choices: Object.fromEntries(custom.map(([n, i]) => [n, (r[i] || '').trim()])) };
    for (const k of Object.keys(GUEST_HEADINGS)) if (!['first', 'last'].includes(k)) g[k] = get(r, k);
    if (!g.name) g.name = [get(r, 'first'), get(r, 'last')].filter(Boolean).join(' ');
    return g;
  }).filter(g => g.name);
}

async function importGuests(file) {
  const rows = parseCSV(await file.text());
  if (!rows.length) return toast('That file looks empty');
  const guests = rowsToGuests(rows);
  if (!guests.length) return toast('No guest names found in that file');
  const preview = guests.slice(0, 3).map(g => g.name).join(', ') + (guests.length > 3 ? '…' : '');
  if (!confirm(`Import ${guests.length} guest${guests.length === 1 ? '' : 's'}? (${preview})\nNames already on your list will be skipped.`)) return;
  const r = await api('POST', '/api/guests/import', { guests });
  toast(`Added ${r.added}` + (r.skipped ? `, skipped ${r.skipped}` : '') + (r.tables_created ? `, created ${r.tables_created} table${r.tables_created === 1 ? '' : 's'}` : ''));
  load();
}

/* ------------------------------------------------------------------ food / menu */

function food() {
  const kid = g => (dish(g.main_id) || {}).course === 'kids';
  const missing = [];
  for (const c of S.menu_courses) {
    if (!c.choose || c.key === 'kids') continue;
    if (!dishes(c.key).length && !(c.key === 'main' && dishes('kids').length)) continue;
    const names = servingPool(c).filter(g => g.rsvp === 'Attending' && !choiceOf(g, c.key)
      && !(c.key !== 'main' && kid(g))).map(g => g.name);
    if (names.length) missing.push([c.name, names]);
  }
  const dietary = S.guests.filter(g => g.rsvp !== 'Declined' && g.dietary);
  const card = c => {
    const pool = servingPool(c), items = dishes(c.key);
    const count = (m, rsvp) => pool.filter(g => g.rsvp === rsvp && chose(g, m)).length;
    const yes = pool.filter(g => g.rsvp === 'Attending').length, maybe = pool.filter(g => g.rsvp === 'Pending').length;
    const tags = [c.serving === 'evening' ? 'Evening' : 'Day', c.choose ? 'Guests choose' : 'Served to all'];
    return `<section class="card course">
      <div class="card-head"><h2>${esc(c.name)}</h2>
        <span class="course-actions"><button class="link" data-add-dish="${esc(c.key)}">+ add</button>
          <button class="link muted-link" data-edit-course="${c.id}">Edit</button></span></div>
      <div class="course-tags">${tags.map(t => `<span class="badge">${t}</span>`).join('')}
        ${c.key === 'kids' ? '<span class="muted small">Shown in the Mains drop-down</span>' : ''}
        ${!c.choose ? `<span class="muted small">For ${yes} attending${maybe ? ` <span class="pend">+${maybe}</span>` : ''} ${c.serving === 'evening' ? 'evening' : 'day'} guests</span>` : ''}</div>
      ${items.length ? `<ul class="list">${items.map(m => {
        const y = count(m, 'Attending'), p = count(m, 'Pending');
        return `<li><div class="grow" data-edit-dish="${m.id}"><b>${esc(m.name)}</b>
            ${m.dietary ? `<span class="chip" style="--c:var(--sage-dark)">${esc(m.dietary)}</span>` : ''}
            ${m.description ? `<small>${esc(m.description)}</small>` : ''}</div>
          ${c.choose ? `<span class="count"><b>${y}</b>${p ? ` <span class="pend">+${p}</span>` : ''}</span>` : ''}</li>`;
      }).join('')}</ul>` : `<p class="muted">Nothing here yet.</p>`}
    </section>`;
  };
  return `
  <div class="container">
    <div class="page-head"><h1>Food</h1>
      <div class="actions"><button class="btn" id="export-caterer" ${S.guests.length ? '' : 'disabled'}>Export for caterer</button>
        <button class="btn" id="add-course">+ Course</button>
        <button class="btn primary" id="add-dish" ${S.menu_courses.length ? '' : 'disabled'}>+ Dish</button></div></div>
    <p class="muted intro">Add your courses and dishes, such as canapés, the wedding breakfast or evening pizza. For courses where guests choose, pick each guest's dish on the Guests tab. Counts are for attending guests, with replies still pending shown as <span class="pend">+n</span>.</p>
    <div class="grid2">${S.menu_courses.map(card).join('') || '<p class="muted">No courses yet. Add one with “+ Course”.</p>'}</div>
    ${missing.length ? `<section class="card"><h2>Still to choose</h2>
      ${missing.map(([c, names]) => `<p><b>${esc(c)}:</b> <span class="muted">${names.map(esc).join(', ')}</span></p>`).join('')}</section>` : ''}
    <section class="card"><h2>Dietary requirements</h2>
      ${dietary.length ? `<ul class="list">${dietary.map(g => `<li><b>${esc(g.name)}</b><span class="grow">&nbsp;– ${esc(g.dietary)}</span>
        <span class="muted">${esc(mealSummary(g))}</span></li>`).join('')}</ul>` : '<p class="muted">None recorded yet. Add them on each guest.</p>'}
    </section>
  </div>`;
}

function editCourse(c = {}) {
  const builtin = !!BUILTIN_FIELD[c.key];
  openForm(c.id ? 'Edit course' : 'Add a course', [
    { key: 'name', label: 'Name', required: true, placeholder: 'e.g. Canapés, Evening food' },
    { key: 'serving', label: 'Served', type: 'select', options: [['day', 'During the day'], ['evening', 'In the evening']], default: 'day' },
    { key: 'choose', label: 'Guests choose a dish from this course', type: 'checkbox', default: 1 },
    { key: 'sort', label: 'Order on the page', type: 'number', default: S.menu_courses.length },
    ...(builtin ? [{ key: 'note', type: 'note', wide: true, text: () => c.key === 'kids'
      ? 'Kids dishes appear in the Mains drop-down on each guest.' : 'This is one of the standard courses, so its choices appear on the guest form.' }] : []),
  ], c, d => save('menu_courses', c, d),
  c.id ? () => { if (dishes(c.key).length && !confirm(`This also deletes the ${dishes(c.key).length} dish(es) in ${c.name}. Continue?`)) return; return remove('menu_courses', c.id); } : null);
}

function editDish(m = {}, key) {
  key ||= m.course || (S.menu_courses[0] || {}).key;
  openForm(m.id ? 'Edit dish' : 'Add a dish', [
    { key: 'course', label: 'Course', type: 'select', options: S.menu_courses.map(c => [c.key, c.name]), default: key },
    { key: 'name', label: 'Dish', required: true, placeholder: 'e.g. Wood-fired pizza' },
    { key: 'dietary', label: 'Dietary label', placeholder: 'e.g. V, VG, GF' },
    { key: 'sort', label: 'Order', type: 'number', default: dishes(key).length },
    { key: 'description', label: 'Description', type: 'textarea', wide: true },
  ], m, d => save('menu_items', m, d), m.id ? () => remove('menu_items', m.id) : null);
}

function exportCaterer() {
  const live = S.guests.filter(g => g.rsvp !== 'Declined' && invited(g));
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const picked = S.menu_courses.filter(c => c.choose && c.key !== 'kids');
  const rows = [['Name', 'RSVP', 'Invite', 'Table', ...picked.map(c => c.name), 'Dietary'],
    ...live.map(g => [g.name, g.rsvp, g.invite, tableName(g),
      ...picked.map(c => (dish(choiceOf(g, c.key)) || {}).name || (c.key === 'main' ? g.meal : '')), g.dietary]),
    [], ['Totals (attending)', 'Course', 'Count'],
    ...S.menu_items.map(m => {
      const c = course(m.course) || {}, pool = servingPool(c).filter(g => g.rsvp === 'Attending');
      return [m.name, c.name, c.choose ? pool.filter(g => chose(g, m)).length : `all ${pool.length}`];
    })];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = 'caterer-summary.csv'; a.click();
}

/* ------------------------------------------------------------------ seating planner */

let seatEvening = false;     // include evening-only guests
let selectedGuest = null;    // tap-to-seat on touch screens

const initials = n => n.replace(/\(.*?\)/g, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const guestsAt = tid => S.guests.filter(g => g.table_id === tid).sort((a, b) => a.name.localeCompare(b.name));

function tableSVG(t, seated) {
  const n = Math.max(1, t.seats), dot = 13;
  const seat = (x, y, i) => {
    const g = seated[i];
    return `<g class="seat ${g ? 'taken' : ''}">${g ? `<title>${esc(g.name)}</title>` : ''}
      <circle cx="${x}" cy="${y}" r="${dot}"/>${g ? `<text x="${x}" y="${y + 4}">${esc(initials(g.name))}</text>` : ''}</g>`;
  };
  if (t.shape === 'rect') {
    const top = Math.ceil(n / 2), bottom = n - top, gap = 34;
    const w = Math.max(110, top * gap + 16), h = 150, tw = w - 16;
    let seats = '';
    for (let i = 0; i < top; i++) seats += seat(8 + gap / 2 + i * gap + (tw - top * gap) / 2, 18, i);
    for (let i = 0; i < bottom; i++) seats += seat(8 + gap / 2 + i * gap + (tw - bottom * gap) / 2, h - 18, top + i);
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect class="top" x="8" y="38" width="${tw}" height="${h - 76}" rx="6"/>${seats}</svg>`;
  }
  const R = Math.max(42, n * 6.2), size = (R + 32) * 2, c = size / 2;
  let seats = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    seats += seat(c + Math.cos(a) * (R + 16), c + Math.sin(a) * (R + 16), i);
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle class="top" cx="${c}" cy="${c}" r="${R - 4}"/>${seats}</svg>`;
}

function seating() {
  const pool = S.guests.filter(g => g.rsvp !== 'Declined' && invited(g) && (seatEvening || g.invite !== 'Evening'));
  const unseated = pool.filter(g => !seatTable(g.table_id));
  const seats = S.seating_tables.reduce((a, t) => a + t.seats, 0);
  const seatedCount = S.guests.filter(g => seatTable(g.table_id)).length;
  const floorH = Math.max(560, ...S.seating_tables.map(t => t.y + 420));
  return `
  <div class="container wide">
    <div class="page-head"><h1>Seating plan</h1>
      <div class="actions">
        <label class="check"><input type="checkbox" id="seat-evening" ${seatEvening ? 'checked' : ''}> Include evening guests</label>
        <button class="btn primary" id="add-table">+ Table</button></div></div>
    <div class="stats">
      <div class="stat"><span>Tables</span><b>${S.seating_tables.length}</b></div>
      <div class="stat"><span>Seats</span><b>${seats}</b></div>
      <div class="stat good"><span>Seated</span><b>${seatedCount}</b></div>
      <div class="stat warn"><span>Still to seat</span><b>${unseated.length}</b><small>Declined and not-yet-invited guests are left out</small></div>
    </div>
    <div class="seating">
      <aside class="card unseated" data-drop-unseat="1">
        <h2>To seat <span class="muted">${unseated.length}</span></h2>
        <p class="muted hint">Drag a name onto a table, or tap a name and then tap a table.</p>
        <div class="gchips">${unseated.map(g => `<span class="gchip ${selectedGuest === g.id ? 'sel' : ''}" data-guest="${g.id}">
          ${esc(g.name)}${g.rsvp === 'Pending' ? ' <i title="Not replied yet">?</i>' : ''}</span>`).join('') ||
          `<p class="muted">${S.guests.length ? 'Everyone has a seat 🎉' : 'Add guests on the Guests tab first.'}</p>`}</div>
      </aside>
      <div class="floor-wrap"><div class="floor" id="floor" style="height:${floorH}px">
        ${S.seating_tables.map(t => {
          const seated = guestsAt(t.id), full = seated.length >= t.seats;
          return `<div class="stable ${selectedGuest ? 'target' : ''}" data-table="${t.id}" style="left:${t.x}px;top:${t.y}px">
            <div class="stable-head" data-move-table="${t.id}" title="Drag to move">
              <b>${esc(t.name)}</b><span class="badge ${seated.length > t.seats ? 'bad' : full ? 's-booked' : ''}">${seated.length}/${t.seats}</span>
              <button class="link" data-edit-table="${t.id}" title="Edit table">Edit</button></div>
            <div class="stable-shape">${tableSVG(t, seated)}</div>
            <ul class="stable-guests">${seated.map(g => `<li><span class="gchip small" data-guest="${g.id}">${esc(g.name)}</span>
              <button class="x" data-unseat="${g.id}" title="Remove from table">×</button></li>`).join('')}</ul>
          </div>`;
        }).join('') || '<p class="muted floor-empty">Add your first table with “+ Table”. Pick round or rectangular and the number of seats.</p>'}
      </div></div>
    </div>
  </div>`;
}

function editTable(t = {}) {
  const n = S.seating_tables.length;
  openForm(t.id ? 'Edit table' : 'Add a table', [
    { key: 'name', label: 'Name', required: true, default: `Table ${n + 1}` },
    { key: 'shape', label: 'Shape', type: 'select', options: [['round', 'Round'], ['rect', 'Rectangular']] },
    { key: 'seats', label: 'Seats', type: 'number', default: 8 },
  ], t, d => {
    d.seats = Math.max(1, Math.min(40, parseInt(d.seats, 10) || 8));
    if (!t.id) { d.x = 20 + (n % 3) * 270; d.y = 20 + Math.floor(n / 3) * 330; }
    return save('seating_tables', t, d);
  }, t.id ? () => remove('seating_tables', t.id) : null);
}

async function seatGuest(gid, tid) {
  const t = seatTable(tid), g = S.guests.find(x => x.id === gid);
  if (!g || g.table_id === tid) return;
  if (t && guestsAt(tid).length >= t.seats) return toast(`${t.name} is full - add seats with Edit`);
  selectedGuest = null;
  await save('guests', g, { table_id: tid || '' });
}

// Pointer-based dragging (works with mouse and touch): guests onto tables, tables around the floor.
document.getElementById('view').addEventListener('pointerdown', e => {
  if (view !== 'seating' || e.button > 0) return;
  const chip = e.target.closest('.gchip[data-guest]');
  const head = e.target.closest('[data-move-table]');
  if (head && !e.target.closest('button')) return dragTable(e, head.closest('.stable'));
  if (!chip) return;
  e.preventDefault();
  const gid = +chip.dataset.guest, sx = e.clientX, sy = e.clientY;
  let ghost = null;
  const move = ev => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!ghost) { ghost = chip.cloneNode(true); ghost.classList.add('ghost'); document.body.appendChild(ghost); chip.classList.add('dragging'); }
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    document.querySelectorAll('.stable.over').forEach(x => x.classList.remove('over'));
    ghost.hidden = true;
    document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.stable')?.classList.add('over');
    ghost.hidden = false;
  };
  const up = ev => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    if (!ghost) {                       // a tap: select / deselect for tap-to-seat
      selectedGuest = selectedGuest === gid ? null : gid; return render();
    }
    ghost.remove(); chip.classList.remove('dragging');
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const table = under?.closest('.stable');
    if (table) return seatGuest(gid, +table.dataset.table);
    if (under?.closest('[data-drop-unseat]')) return seatGuest(gid, null);
    render();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
});

function dragTable(e, el) {
  e.preventDefault();
  const id = +el.dataset.table, t = seatTable(id);
  const sx = e.clientX, sy = e.clientY, ox = t.x, oy = t.y;
  el.classList.add('moving');
  const move = ev => {
    el.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
    el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
  };
  const up = async ev => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    el.classList.remove('moving');
    const x = Math.round(Math.max(0, ox + ev.clientX - sx)), y = Math.round(Math.max(0, oy + ev.clientY - sy));
    if (x !== t.x || y !== t.y) { t.x = x; t.y = y; await api('PUT', `/api/seating_tables/${id}`, { x, y }); render(); }
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

/* ------------------------------------------------------------------ setup wizard */

const wiz = { step: 0, data: {}, busy: false, result: null,
  starter: { checklist: true, venue_cost: true, example_costs: false, example_guests: false }, cats: null };
const WIZ_DONE = 5;

function renderWizard() {
  const d = wiz.data;
  const steps = [
    () => `<h1>Let's plan your wedding</h1>
      <p class="muted">First, who's getting married?</p>
      <div class="form-grid">
        <label class="field"><span>Partner 1</span><input id="w_partner1" value="${esc(d.partner1 || '')}" autocomplete="off"></label>
        <label class="field"><span>Partner 2</span><input id="w_partner2" value="${esc(d.partner2 || '')}" autocomplete="off"></label>
      </div>
      <div class="wiz-preview" id="wiz-preview"></div>`,
    () => `<h1>When's the big day?</h1>
      <p class="muted">This sets the countdown and dates your checklist.</p>
      <div class="form-grid">
        <label class="field"><span>Wedding date</span><input type="date" id="w_wedding_date" value="${esc(d.wedding_date || '')}"></label>
        <label class="field"><span>Ceremony time (optional)</span><input type="time" id="w_wedding_time" value="${esc(d.wedding_time ?? '13:00')}"></label>
      </div>`,
    () => `<h1>Where's it happening?</h1>
      <p class="muted">Not booked yet? Leave these blank and add them later in Settings.</p>
      <div class="form-grid">
        <label class="field wide"><span>Venue (if known)</span><input id="w_venue_name" value="${esc(d.venue_name || '')}" placeholder="e.g. The Old Barn"></label>
        <label class="field wide"><span>Venue website (optional)</span><input id="w_venue_url" value="${esc(d.venue_url || '')}" placeholder="https://…" inputmode="url"></label>
      </div>
      <p class="muted">We'll grab a photo from the venue's website for your header. You can change it any time.</p>`,
    () => {
      wiz.cats ||= Object.fromEntries(S.default_categories.map(c => [c.name, c.on]));
      return `<h1>Budget categories</h1>
      <p class="muted">Tap to choose which categories you'll track spending in. You can add your own later.</p>
      <div class="chips">${S.default_categories.map(c => `<button type="button" class="pick ${wiz.cats[c.name] ? 'on' : ''}"
          data-pick="${esc(c.name)}" style="--c:${esc(c.colour)}">${wiz.cats[c.name] ? '✓ ' : '+ '}${esc(c.name)}</button>`).join('')}</div>
      <div class="pick-actions"><button type="button" class="link" data-pick-all="1">Select all</button> ·
        <button type="button" class="link" data-pick-all="0">Clear</button>
        <span class="muted">· ${Object.values(wiz.cats).filter(Boolean).length} selected</span></div>`;
    },
    () => {
      const opt = (key, title, desc) => `<label><input type="checkbox" data-starter="${key}" ${wiz.starter[key] ? 'checked' : ''}>
        <span><b>${title}</b><small>${desc}</small></span></label>`;
      return `<h1>What should we set up?</h1>
      <p class="muted">Pick what you'd like to start with. You can add or delete anything later.</p>
      <div class="starter">
        ${opt('checklist', 'UK wedding checklist', 'About 40 tasks dated back from your wedding day. They show in Coming up and on the calendar.')}
        ${d.venue_name && wiz.cats?.Venue ? opt('venue_cost', `Add ${esc(d.venue_name)} to the budget`, 'A booked cost ready for the price and payment schedule.') : ''}
        ${opt('example_costs', 'Example costs and payments', 'A few sample costs to show how deposits and deadlines work. One click removes them in Settings.')}
        ${opt('example_guests', 'Example guests', 'A few sample guests with RSVPs and dietary needs.')}
      </div>`;
    },
    () => wiz.busy ? `<div class="wiz-busy"><div class="spinner"></div><h1>Setting things up…</h1>
        <p class="muted">Getting your planner ready${d.venue_url ? ' and fetching a photo of the venue' : ''}.</p></div>`
      : `<h1>All set, ${esc(d.partner1)} &amp; ${esc(d.partner2)} 🎉</h1>
        ${wiz.result?.photo ? `<img class="wiz-photo" src="${esc(wiz.result.photo)}" alt="Venue">` : ''}
        ${wiz.result?.photo_error ? `<p class="muted">${esc(wiz.result.photo_error)}. You can upload a photo in Settings.</p>` : ''}
        <p class="muted">${wiz.starter.checklist ? 'Your checklist is ready and dated from your wedding day.' : 'Your planner is ready.'}</p>`,
  ];
  const last = wiz.step === steps.length - 1;
  document.getElementById('view').innerHTML = `
    <div class="wizard"><div class="wiz-card">
      <div class="wiz-dots">${steps.map((_, i) => `<i class="${i <= wiz.step ? 'on' : ''}"></i>`).join('')}</div>
      ${steps[wiz.step]()}
      <p class="wiz-error" id="wiz-error"></p>
      <div class="modal-actions">
        ${wiz.step > 0 && !last ? '<button class="btn" id="wiz-back">Back</button>' : ''}
        <span class="spacer"></span>
        ${last ? (wiz.busy ? '' : '<button class="btn primary" id="wiz-done">Start planning →</button>')
               : `<button class="btn primary" id="wiz-next">${wiz.step === WIZ_DONE - 1 ? 'Finish' : 'Next'}</button>`}
      </div>
    </div></div>`;
  const preview = () => {
    const el = document.getElementById('wiz-preview'); if (!el) return;
    const a = document.getElementById('w_partner1').value.trim(), b = document.getElementById('w_partner2').value.trim();
    el.innerHTML = a || b ? `${esc(a || '…')} <span class="amp">&amp;</span> ${esc(b || '…')}` : '';
  };
  preview();
  document.querySelectorAll('.wiz-card input').forEach(i => {
    i.addEventListener('input', () => { preview(); document.getElementById('wiz-error').textContent = ''; });
    i.addEventListener('keydown', ev => { if (ev.key === 'Enter') document.getElementById('wiz-next')?.click(); });
  });
  document.querySelector('.wiz-card input')?.focus();
  document.getElementById('wiz-back')?.addEventListener('click', () => { collectWizard(); wiz.step--; renderWizard(); });
  document.getElementById('wiz-next')?.addEventListener('click', wizardNext);
  document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    wiz.cats[b.dataset.pick] = !wiz.cats[b.dataset.pick]; renderWizard();
  }));
  document.querySelectorAll('[data-pick-all]').forEach(b => b.addEventListener('click', () => {
    for (const k in wiz.cats) wiz.cats[k] = b.dataset.pickAll === '1'; renderWizard();
  }));
  document.getElementById('wiz-done')?.addEventListener('click', () => {
    wiz.step = 0; location.hash = 'overview'; view = 'overview'; render();
  });
}

function collectWizard() {
  document.querySelectorAll('.wiz-card input[id^="w_"]').forEach(i => { wiz.data[i.id.slice(2)] = i.value.trim(); });
  document.querySelectorAll('.wiz-card input[data-starter]').forEach(i => { wiz.starter[i.dataset.starter] = i.checked; });
}

async function wizardNext() {
  collectWizard();
  const d = wiz.data, err = msg => { document.getElementById('wiz-error').textContent = msg; };
  if (wiz.step === 0 && (!d.partner1 || !d.partner2)) return err('Please enter both names.');
  if (wiz.step === 1 && !d.wedding_date) return err('Please choose your wedding date.');
  if (wiz.step === WIZ_DONE - 1) {
    wiz.step = WIZ_DONE; wiz.busy = true; renderWizard();
    try {
      wiz.result = await api('POST', '/api/setup', { ...d, starter: { ...wiz.starter,
        venue_cost: wiz.starter.venue_cost && !!d.venue_name,
        categories: Object.keys(wiz.cats || {}).filter(k => wiz.cats[k]) } });
      S = await api('GET', '/api/state');
    } catch (e) { wiz.step = WIZ_DONE - 1; wiz.busy = false; renderWizard(); return; }
    wiz.busy = false;
    return renderWizard();   // show the result screen before entering the app
  }
  wiz.step++; renderWizard();
}

load();
