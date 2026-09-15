/**
 * Edit This Week: temporary staffing changes, event templates, and date
 * exceptions on the manager schedule page.
 *
 * Loads after app.js and uses its globals (state, dom, roleMap, employeeMap,
 * escHtml, formatHour, showToast, getWeekDates, formatShortDate, ...).
 *
 * Default staffing (Requirements page) is never changed here. Everything is a
 * per-week override document, mirrored on the server by services/week_overrides.py:
 *   { days: { "4": { clear: false, entries: [{mode:'set'|'add', role_id, start_hour, end_hour, count, label}] } } }
 */

state.weekOverrides = { days: {} };
state.eventTemplates = [];
state.weekExceptions = [];
state.editWeekMode = false;

const WEEK_EDIT = { saveTimer: null, saving: false, dirty: false };

// ==================== DATA ====================

async function loadWeekContext() {
    try {
        const res = await fetch(`/api/week/context?weekOffset=${state.weekOffset}&weekStart=${getWeekStartIso()}`);
        const data = await res.json();
        if (data.success) {
            state.weekOverrides = data.overrides || { days: {} };
            state.eventTemplates = data.templates || [];
            state.weekExceptions = data.exceptions || [];
        }
    } catch (err) {
        console.warn('Could not load this week\'s changes:', err);
        state.weekOverrides = { days: {} };
        state.weekExceptions = [];
    }
    updateWeekChangesChip();
    if (state.editWeekMode) renderCoverageEditor();
}

function weekChangeCount(overrides = state.weekOverrides) {
    let n = 0;
    Object.values(overrides?.days || {}).forEach(d => { n += (d.entries || []).length + (d.clear ? 1 : 0); });
    return n;
}

/** Apply the week's overrides to a coverage map "day,hour,role" -> {min,max,is_peak}. */
function applyWeekOverridesToReq(req) {
    const days = state.weekOverrides?.days || {};
    Object.entries(days).forEach(([d, dv]) => {
        const day = parseInt(d);
        if (dv.clear) Object.keys(req).forEach(k => { if (parseInt(k.split(',')[0]) === day) delete req[k]; });
        (dv.entries || []).forEach(e => {
            const lo = Math.max(parseInt(e.start_hour), state.startHour);
            const hi = Math.min(parseInt(e.end_hour), state.endHour);
            for (let h = lo; h < hi; h++) {
                if (!state.hours.includes(h)) continue;
                const key = `${day},${h},${e.role_id}`;
                const cur = req[key];
                const current = cur ? cur.min : 0;
                let nv = e.mode === 'set' ? parseInt(e.count) : current + parseInt(e.count);
                nv = Math.max(0, nv || 0);
                if (nv === 0) delete req[key];
                else req[key] = { min: nv, max: Math.max(cur?.max || 0, nv), is_peak: cur?.is_peak || false };
            }
        });
    });
    return req;
}

/** Contiguous hour ranges with the same head count for one role on one day. */
function coverageSegmentsForDay(req, dayIdx, roleId) {
    const segs = [];
    let cur = null;
    state.hours.forEach(h => {
        const r = req[`${dayIdx},${h},${roleId}`];
        const count = r ? r.min : 0;
        if (count > 0 && cur && cur.endHour === h && cur.count === count) { cur.endHour = h + 1; return; }
        cur = null;
        if (count > 0) { cur = { startHour: h, endHour: h + 1, count }; segs.push(cur); }
    });
    return segs;
}

function baseCountForRange(baseReq, dayIdx, roleId, startHour, endHour) {
    const counts = new Set();
    for (let h = startHour; h < endHour; h++) counts.add(baseReq[`${dayIdx},${h},${roleId}`]?.min || 0);
    return counts.size === 1 ? [...counts][0] : null; // null = varies across the range
}

function dayOverrides(dayIdx, create = false) {
    const days = state.weekOverrides.days = state.weekOverrides.days || {};
    if (!days[dayIdx] && create) days[dayIdx] = { clear: false, entries: [] };
    return days[dayIdx] || null;
}

function dayHasChanges(dayIdx) {
    const d = dayOverrides(dayIdx);
    return !!d && (d.clear || (d.entries || []).length > 0);
}

function pruneDay(dayIdx) {
    const d = dayOverrides(dayIdx);
    if (d && !d.clear && !(d.entries || []).length) delete state.weekOverrides.days[dayIdx];
}

function queueSaveWeekOverrides() {
    WEEK_EDIT.dirty = true;
    clearTimeout(WEEK_EDIT.saveTimer);
    WEEK_EDIT.saveTimer = setTimeout(saveWeekOverrides, 350);
    updateWeekChangesChip();
    renderCoverageEditor();
    refreshScheduleForNewNeeds();
}

async function saveWeekOverrides() {
    if (state.isDemo) { showToast('Sign up to save changes to a week.', 'info'); return; }
    WEEK_EDIT.saving = true;
    try {
        const res = await fetch('/api/week/overrides', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessId: state.business.id, weekOffset: state.weekOffset, weekStart: getWeekStartIso(), overrides: state.weekOverrides }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Could not save');
        state.weekOverrides = data.overrides || { days: {} };
        WEEK_EDIT.dirty = false;
    } catch (err) {
        showToast(err.message || 'Could not save this week\'s changes', 'error');
    } finally {
        WEEK_EDIT.saving = false;
        updateWeekChangesChip();
    }
}

/** Still-needed markers and notes follow the edited needs immediately. */
function refreshScheduleForNewNeeds() {
    if (!state.currentSchedule || !state.currentSchedule.slot_assignments) return;
    try {
        recomputeCoverageGaps();
        updateMetrics(state.currentSchedule);
        updateEmployeeHours(state.currentSchedule);
    } catch (err) { /* metrics panel may be collapsed */ }
}

// ==================== CHIP + MODE ====================

function updateWeekChangesChip() {
    const chip = document.getElementById('weekChangesChip');
    const n = weekChangeCount();
    if (chip) {
        chip.hidden = n === 0;
        chip.innerHTML = `<span class="chip-dot"></span>${n} change${n === 1 ? '' : 's'} this week`;
        chip.title = 'Staffing needs that are different this week only. Click to review.';
    }
    const banner = document.getElementById('editWeekCount');
    if (banner) banner.textContent = n === 0 ? 'No changes yet. This week uses your normal staffing.' : `${n} change${n === 1 ? '' : 's'} this week only${WEEK_EDIT.saving ? ' · saving…' : ''}`;
    const resetBtn = document.getElementById('editWeekResetBtn');
    if (resetBtn) resetBtn.disabled = n === 0;
    const editBtn = document.getElementById('editWeekBtn');
    if (editBtn) {
        editBtn.classList.toggle('has-changes', n > 0 && !state.editWeekMode);
        editBtn.classList.toggle('active', state.editWeekMode);
        editBtn.querySelector('.btn-label').textContent = state.editWeekMode ? 'Done editing' : 'Edit This Week';
    }
}

function setEditWeekMode(on) {
    if (state.editWeekMode === on) return;
    state.editWeekMode = on;
    const panel = document.querySelector('.schedule-panel');
    if (panel) panel.classList.toggle('edit-week-mode', on);
    const editorView = document.getElementById('scheduleViewEditWeek');
    if (on) {
        document.querySelectorAll('.schedule-view').forEach(v => v.classList.remove('active'));
        editorView?.classList.add('active');
        renderCoverageEditor();
        editorView?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        editorView?.classList.remove('active');
        const activeToggle = document.querySelector('.view-toggle-btn.active') || document.querySelector('.view-toggle-btn[data-view="timeline"]');
        activeToggle?.click();
        refreshScheduleForNewNeeds();
    }
    updateWeekChangesChip();
}

// ==================== EDITOR RENDER ====================

function buildCoverageHourHeader() {
    const header = document.createElement('div');
    header.className = 'timeline-day-header';
    const roleHead = document.createElement('div');
    roleHead.className = 'timeline-header-role';
    roleHead.textContent = 'Role';
    const hoursHead = document.createElement('div');
    hoursHead.className = 'timeline-header-hours';
    hoursHead.style.setProperty('--hours', state.hours.length);
    state.hours.forEach(hour => {
        const label = document.createElement('div');
        label.className = 'timeline-hour-label';
        label.textContent = formatHour(hour);
        hoursHead.appendChild(label);
    });
    const closing = document.createElement('div');
    closing.className = 'timeline-hour-label timeline-closing-hour';
    closing.textContent = formatHour(state.endHour);
    hoursHead.appendChild(closing);
    header.append(roleHead, hoursHead);
    return header;
}

function exceptionsForDate(dayIdx) {
    const iso = getWeekDates(state.weekOffset)[dayIdx];
    const key = `${iso.getFullYear()}-${String(iso.getMonth() + 1).padStart(2, '0')}-${String(iso.getDate()).padStart(2, '0')}`;
    return (state.weekExceptions || []).filter(e => e.date === key);
}

function exceptionText(e, withName = true) {
    const who = withName ? `${e.employee_name || employeeMap[e.employee_id]?.name || 'Someone'} ` : '';
    const when = e.all_day ? 'all day' : `${formatHourMinute(e.start_hour)} – ${formatHourMinute(e.end_hour)}`;
    return e.kind === 'available' ? `${who}can work ${when}` : `${who}can't work ${when}`;
}

function renderCoverageEditor() {
    const container = document.getElementById('coverageEditorGrid');
    if (!container) return;
    container.innerHTML = '';
    const totalHours = state.hours.length;
    const baseReq = getWeekCoverageRequirements(false);
    const req = getWeekCoverageRequirements(true);
    const weekDates = getWeekDates(state.weekOffset);
    const roles = [...state.roles].sort((a, b) => a.name.localeCompare(b.name));
    const templates = state.eventTemplates || [];

    state.daysOpen.forEach(dayIdx => {
        const row = document.createElement('div');
        row.className = 'timeline-row cov-row ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd') + (dayHasChanges(dayIdx) ? ' cov-day-changed' : '');
        row.dataset.dayIdx = dayIdx;

        const dayLabel = document.createElement('div');
        dayLabel.className = 'timeline-day-label';
        dayLabel.innerHTML = `<span class="day-name">${state.days[dayIdx].substring(0, 3)}</span><span class="day-date">${formatShortDate(weekDates[dayIdx])}</span>${dayHasChanges(dayIdx) ? '<span class="cov-day-flag">Edited</span>' : ''}`;
        row.appendChild(dayLabel);

        const slots = document.createElement('div');
        slots.className = 'timeline-slots';

        // Day actions
        const actions = document.createElement('div');
        actions.className = 'cov-day-actions';
        const tplOptions = templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)} (${t.mode === 'replace' ? 'replaces the day' : 'adds to the day'})</option>`).join('');
        const excs = exceptionsForDate(dayIdx);
        actions.innerHTML = `
            <button type="button" class="cov-action" data-act="add"><span class="cov-action-plus">+</span> Add a need</button>
            <select class="cov-template-select" data-act="apply" title="Apply a saved event to this day">
                <option value="">Apply template…</option>
                ${tplOptions}
                <option value="__manage">Manage templates…</option>
            </select>
            <button type="button" class="cov-action" data-act="save">Save day as template</button>
            ${templatesAppliedToDay(dayIdx).map(id => { const t = templates.find(x => x.id === id); return `<span class="cov-applied" title="Applied to this day. Click × to take it off."><i></i>${escHtml(t ? t.name : 'Template')}<button type="button" data-remove-tpl="${escHtml(id)}" aria-label="Remove template from this day">&times;</button></span>`; }).join('')}
            ${dayHasChanges(dayIdx) ? '<button type="button" class="cov-action cov-action-reset" data-act="reset">Reset day to normal</button>' : ''}
            ${excs.length ? `<span class="cov-day-excs" title="Date exceptions this day">${excs.map(e => `<span class="cov-exc ${e.kind}">${escHtml(exceptionText(e))}</span>`).join('')}</span>` : ''}
        `;
        actions.querySelector('[data-act="add"]').addEventListener('click', () => openCoverageAddModal(dayIdx));
        actions.querySelector('[data-act="save"]').addEventListener('click', () => openSaveTemplateModal(dayIdx));
        actions.querySelector('[data-act="reset"]')?.addEventListener('click', () => resetDayOverrides(dayIdx));
        actions.querySelectorAll('[data-remove-tpl]').forEach(b => b.addEventListener('click', () => removeTemplateFromDay(dayIdx, b.dataset.removeTpl)));
        actions.querySelector('[data-act="apply"]').addEventListener('change', (e) => {
            const v = e.target.value;
            e.target.value = '';
            if (v === '__manage') openTemplatesModal();
            else if (v) applyTemplateToDay(dayIdx, v);
        });
        slots.appendChild(actions);
        slots.appendChild(buildCoverageHourHeader());

        roles.forEach(role => {
            const segs = coverageSegmentsForDay(req, dayIdx, role.id);
            const roleRow = document.createElement('div');
            roleRow.className = 'timeline-role-row cov-role-row';
            roleRow.style.setProperty('--role-color', role.color || '#64748b');
            const label = document.createElement('div');
            label.className = 'timeline-role-label';
            label.innerHTML = `<span class="role-dot" style="background:${escHtml(role.color)}"></span><span class="role-label-text">${escHtml(role.name)}</span>`;
            const lanes = document.createElement('div');
            lanes.className = 'timeline-role-lanes';
            lanes.style.setProperty('--hours', totalHours);
            const lane = document.createElement('div');
            lane.className = 'timeline-slots-row cov-lane' + (segs.length ? '' : ' cov-lane-empty');
            if (!segs.length) {
                lane.title = `No ${role.name} needed on ${state.days[dayIdx]}. Click to add.`;
                lane.innerHTML = `<span class="cov-lane-hint">No ${escHtml(role.name)} needed · click to add</span>`;
                lane.addEventListener('click', () => openCoverageAddModal(dayIdx, role.id));
            }
            segs.forEach(seg => {
                const base = baseCountForRange(baseReq, dayIdx, role.id, seg.startHour, seg.endHour);
                const changed = base !== seg.count;
                const bar = document.createElement('div');
                bar.className = 'cov-bar' + (changed ? ' is-changed' : '');
                bar.style.left = `${(state.hours.indexOf(seg.startHour) / totalHours) * 100}%`;
                bar.style.width = `${((seg.endHour - seg.startHour) / totalHours) * 100}%`;
                const diff = changed ? (base === null ? 'edited' : base === 0 ? 'new' : `was ${base}`) : '';
                bar.innerHTML = `<span class="cov-bar-count">${escHtml(role.name)} × ${seg.count}</span><span class="cov-bar-time">${formatHour(seg.startHour)} – ${formatHour(seg.endHour)}</span>${diff ? `<span class="cov-bar-diff">${diff}</span>` : ''}`;
                bar.title = `${role.name}: ${seg.count} needed ${formatHour(seg.startHour)} – ${formatHour(seg.endHour)}${changed ? ` (normally ${base === null ? 'varies' : base})` : ''}\nClick to change for this shift only`;
                bar.addEventListener('click', (e) => { e.stopPropagation(); openCoverageBarModal(dayIdx, role.id, seg, base); });
                lane.appendChild(bar);
            });
            lanes.appendChild(lane);
            roleRow.append(label, lanes);
            slots.appendChild(roleRow);
        });

        row.appendChild(slots);
        container.appendChild(row);
    });
}

// ==================== OVERRIDE EDITS ====================

function removeEntriesForRange(dayIdx, roleId, startHour, endHour) {
    const d = dayOverrides(dayIdx);
    if (!d) return;
    d.entries = (d.entries || []).filter(e => !(e.role_id === roleId && e.start_hour === startHour && e.end_hour === endHour));
}

function setNeedForRange(dayIdx, roleId, startHour, endHour, count, baseCount) {
    const d = dayOverrides(dayIdx, true);
    removeEntriesForRange(dayIdx, roleId, startHour, endHour);
    // Back to the normal number: no entry needed unless earlier entries still touch these hours
    const stillTouched = (d.entries || []).some(e => e.role_id === roleId && e.start_hour < endHour && e.end_hour > startHour) || d.clear;
    if (count !== baseCount || stillTouched || baseCount === null) {
        d.entries.push({ mode: 'set', role_id: roleId, start_hour: startHour, end_hour: endHour, count });
    }
    pruneDay(dayIdx);
    queueSaveWeekOverrides();
}

function addNeed(dayIdx, roleId, startHour, endHour, count, label) {
    const d = dayOverrides(dayIdx, true);
    const entry = { mode: 'add', role_id: roleId, start_hour: startHour, end_hour: endHour, count };
    if (label) entry.label = label;
    d.entries.push(entry);
    queueSaveWeekOverrides();
}

function resetDayOverrides(dayIdx) {
    if (!dayHasChanges(dayIdx)) return;
    delete state.weekOverrides.days[dayIdx];
    queueSaveWeekOverrides();
    showToast(`${state.days[dayIdx]} is back to normal staffing`, 'success');
}

function resetWeekOverrides() {
    if (!weekChangeCount()) return;
    if (!confirm('Remove every change for this week and go back to your normal staffing?')) return;
    state.weekOverrides = { days: {} };
    queueSaveWeekOverrides();
    showToast('This week is back to normal staffing', 'success');
}

/** Templates applied to a day (by id, in order), from the entries' tags. */
function templatesAppliedToDay(dayIdx) {
    const d = dayOverrides(dayIdx);
    const ids = [];
    (d?.entries || []).forEach(e => { if (e.template_id && !ids.includes(e.template_id)) ids.push(e.template_id); });
    return ids;
}

function removeTemplateFromDay(dayIdx, templateId, save = true) {
    const d = dayOverrides(dayIdx);
    if (!d) return;
    const wasReplace = (d.entries || []).some(e => e.template_id === templateId && e.template_mode === 'replace');
    d.entries = (d.entries || []).filter(e => e.template_id !== templateId);
    // A "replace the day" template also owns the day's clear flag
    if (wasReplace && !(d.entries || []).some(e => e.template_mode === 'replace')) d.clear = false;
    pruneDay(dayIdx);
    if (save) queueSaveWeekOverrides();
}

/**
 * Applying a template is idempotent: the day ends up with exactly what the
 * template says, however many times it is clicked. Earlier entries from the
 * same template are removed first.
 */
function applyTemplateToDay(dayIdx, templateId) {
    const tpl = (state.eventTemplates || []).find(t => t.id === templateId);
    if (!tpl) return;
    const already = templatesAppliedToDay(dayIdx).includes(templateId);
    removeTemplateFromDay(dayIdx, templateId, false);
    const d = dayOverrides(dayIdx, true);
    const tag = { label: tpl.name, template_id: tpl.id, template_mode: tpl.mode };
    if (tpl.mode === 'replace') {
        d.clear = true;
        d.entries = tpl.items.map(it => ({ mode: 'set', role_id: it.role_id, start_hour: it.start_hour, end_hour: it.end_hour, count: Math.max(0, it.count), ...tag }));
    } else {
        tpl.items.forEach(it => d.entries.push({ mode: 'add', role_id: it.role_id, start_hour: it.start_hour, end_hour: it.end_hour, count: it.count, ...tag }));
    }
    queueSaveWeekOverrides();
    showToast(already ? `${tpl.name} is already applied to ${state.days[dayIdx]}` : `${tpl.name} applied to ${state.days[dayIdx]}`, 'success');
}

/** Items describing a day: the whole day (replace) or just what differs from normal (add). */
function templateItemsFromDay(dayIdx, mode) {
    const baseReq = getWeekCoverageRequirements(false);
    const req = getWeekCoverageRequirements(true);
    const items = [];
    state.roles.forEach(role => {
        let cur = null;
        state.hours.forEach(h => {
            const now = req[`${dayIdx},${h},${role.id}`]?.min || 0;
            const was = baseReq[`${dayIdx},${h},${role.id}`]?.min || 0;
            const value = mode === 'replace' ? now : now - was;
            if (value !== 0 && cur && cur.end_hour === h && cur.count === value) { cur.end_hour = h + 1; return; }
            cur = null;
            if (value !== 0) { cur = { role_id: role.id, start_hour: h, end_hour: h + 1, count: value }; items.push(cur); }
        });
    });
    return items;
}

// ==================== MODALS ====================

function ensureModal(id, html) {
    let el = document.getElementById(id);
    if (el) return el;
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    el = wrap.firstElementChild;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModalEl(el); });
    el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModalEl(el)));
    return el;
}
function openModalEl(el) { el.style.display = 'flex'; el.classList.add('active'); }
function closeModalEl(el) { el.style.display = 'none'; el.classList.remove('active'); }

function hourOptions(selected, from = state.startHour, to = state.endHour) {
    let out = '';
    for (let h = from; h <= to; h++) out += `<option value="${h}" ${h === selected ? 'selected' : ''}>${formatHour(h)}</option>`;
    return out;
}

function stepperHtml(id, value, min = 0) {
    return `<div class="cov-stepper" id="${id}" data-min="${min}"><button type="button" class="cov-step" data-d="-1" aria-label="Fewer">−</button><span class="cov-step-value">${value}</span><button type="button" class="cov-step" data-d="1" aria-label="More">+</button></div>`;
}
function wireStepper(el, onChange) {
    const val = el.querySelector('.cov-step-value');
    el.querySelectorAll('.cov-step').forEach(b => b.onclick = () => {
        const n = Math.max(parseInt(el.dataset.min) || 0, parseInt(val.textContent) + parseInt(b.dataset.d));
        val.textContent = n;
        if (onChange) onChange(n);
    });
}
function stepperValue(el) { return parseInt(el.querySelector('.cov-step-value').textContent) || 0; }

function openCoverageBarModal(dayIdx, roleId, seg, base) {
    const role = roleMap[roleId] || { name: roleId, color: '#64748b' };
    const el = ensureModal('covBarModal', `
        <div class="modal-overlay cov-modal" id="covBarModal" style="display:none">
            <div class="modal-content modal-sm">
                <div class="modal-header"><h2 id="covBarTitle"></h2><button class="modal-close" data-close aria-label="Close">&times;</button></div>
                <div class="modal-body">
                    <div class="cov-modal-when" id="covBarWhen"></div>
                    <div class="cov-count-row">
                        <div class="cov-count-normal"><span class="cov-count-label">Normal</span><span class="cov-count-num" id="covBarNormal"></span></div>
                        <div class="cov-count-week"><span class="cov-count-label">This shift only</span><div id="covBarStepperWrap"></div></div>
                    </div>
                    <p class="cov-modal-hint">This changes <strong>this shift only</strong>. Every other week, and your normal staffing on the Requirements page, stay the same.</p>
                </div>
                <div class="modal-footer cov-modal-footer">
                    <button type="button" class="btn btn-ghost cov-remove-btn" id="covBarRemove">Remove for this day</button>
                    <span class="spacer"></span>
                    <button type="button" class="btn btn-secondary" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="covBarSave">Save</button>
                </div>
            </div>
        </div>`);
    const dayDate = getWeekDates(state.weekOffset)[dayIdx];
    el.querySelector('#covBarTitle').innerHTML = `<span class="role-dot" style="background:${escHtml(role.color)}"></span>${escHtml(role.name)}`;
    el.querySelector('#covBarWhen').textContent = `${state.days[dayIdx]}, ${formatShortDate(dayDate)} · ${formatHour(seg.startHour)} – ${formatHour(seg.endHour)}`;
    el.querySelector('#covBarNormal').textContent = base === null ? 'varies' : base;
    const wrap = el.querySelector('#covBarStepperWrap');
    wrap.innerHTML = stepperHtml('covBarStepper', seg.count, 0);
    const stepper = wrap.firstElementChild;
    const sync = (n) => stepper.classList.toggle('is-changed', n !== base);
    wireStepper(stepper, sync); sync(seg.count);
    el.querySelector('#covBarSave').onclick = () => {
        setNeedForRange(dayIdx, roleId, seg.startHour, seg.endHour, stepperValue(stepper), base);
        closeModalEl(el);
    };
    el.querySelector('#covBarRemove').onclick = () => {
        setNeedForRange(dayIdx, roleId, seg.startHour, seg.endHour, 0, base);
        closeModalEl(el);
    };
    openModalEl(el);
}

function openCoverageAddModal(dayIdx, roleId = null) {
    const el = ensureModal('covAddModal', `
        <div class="modal-overlay cov-modal" id="covAddModal" style="display:none">
            <div class="modal-content modal-sm">
                <div class="modal-header"><h2>Add a need</h2><button class="modal-close" data-close aria-label="Close">&times;</button></div>
                <div class="modal-body">
                    <div class="cov-modal-when" id="covAddWhen"></div>
                    <div class="cov-form-grid">
                        <label>Role<select id="covAddRole" class="form-select"></select></label>
                        <label>How many more<div id="covAddStepperWrap"></div></label>
                        <label>From<select id="covAddStart" class="form-select"></select></label>
                        <label>Until<select id="covAddEnd" class="form-select"></select></label>
                    </div>
                    <p class="cov-modal-hint">Added on top of whatever is normally needed at those hours, <strong>this shift only</strong>.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="covAddSave">Add</button>
                </div>
            </div>
        </div>`);
    const dayDate = getWeekDates(state.weekOffset)[dayIdx];
    el.querySelector('#covAddWhen').textContent = `${state.days[dayIdx]}, ${formatShortDate(dayDate)}`;
    const roleSel = el.querySelector('#covAddRole');
    roleSel.innerHTML = [...state.roles].sort((a, b) => a.name.localeCompare(b.name)).map(r => `<option value="${escHtml(r.id)}" ${r.id === roleId ? 'selected' : ''}>${escHtml(r.name)}</option>`).join('');
    const startSel = el.querySelector('#covAddStart'), endSel = el.querySelector('#covAddEnd');
    const defaultStart = Math.max(state.startHour, Math.min(state.endHour - 1, 17));
    startSel.innerHTML = hourOptions(defaultStart, state.startHour, state.endHour - 1);
    endSel.innerHTML = hourOptions(state.endHour, state.startHour + 1, state.endHour);
    const wrap = el.querySelector('#covAddStepperWrap');
    wrap.innerHTML = stepperHtml('covAddStepper', 1, 1);
    wireStepper(wrap.firstElementChild);
    el.querySelector('#covAddSave').onclick = () => {
        const s = parseInt(startSel.value), e = parseInt(endSel.value);
        if (e <= s) { showToast('The end time must be after the start time', 'error'); return; }
        addNeed(dayIdx, roleSel.value, s, e, stepperValue(wrap.firstElementChild));
        closeModalEl(el);
    };
    openModalEl(el);
}

function openSaveTemplateModal(dayIdx) {
    const el = ensureModal('covSaveTplModal', `
        <div class="modal-overlay cov-modal" id="covSaveTplModal" style="display:none">
            <div class="modal-content modal-sm">
                <div class="modal-header"><h2>Save day as a template</h2><button class="modal-close" data-close aria-label="Close">&times;</button></div>
                <div class="modal-body">
                    <div class="cov-modal-when" id="covTplWhen"></div>
                    <label class="cov-field">Name<input type="text" id="covTplName" class="form-input" placeholder="Private Event, Game Night, Holiday Brunch…" maxlength="60"></label>
                    <div class="cov-field">When applied to a day, it should…
                        <label class="cov-radio"><input type="radio" name="covTplMode" value="add" checked><span><strong>Add</strong> this day's changes on top of a normal day<small id="covTplAddSummary"></small></span></label>
                        <label class="cov-radio"><input type="radio" name="covTplMode" value="replace"><span><strong>Replace</strong> the normal day with exactly this day<small id="covTplReplaceSummary"></small></span></label>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="covTplSave">Save template</button>
                </div>
            </div>
        </div>`);
    const dayDate = getWeekDates(state.weekOffset)[dayIdx];
    el.querySelector('#covTplWhen').textContent = `${state.days[dayIdx]}, ${formatShortDate(dayDate)}`;
    const addItems = templateItemsFromDay(dayIdx, 'add');
    const replaceItems = templateItemsFromDay(dayIdx, 'replace');
    const summarize = (items) => items.length ? items.slice(0, 4).map(it => `${it.count > 0 && items === addItems ? '+' : ''}${it.count} ${roleMap[it.role_id]?.name || it.role_id} ${formatHour(it.start_hour)}–${formatHour(it.end_hour)}`).join(', ') + (items.length > 4 ? ', …' : '') : 'nothing to save';
    el.querySelector('#covTplAddSummary').textContent = summarize(addItems);
    el.querySelector('#covTplReplaceSummary').textContent = summarize(replaceItems);
    const addRadio = el.querySelector('input[value="add"]'), repRadio = el.querySelector('input[value="replace"]');
    addRadio.disabled = !addItems.length;
    if (!addItems.length) repRadio.checked = true;
    const nameInput = el.querySelector('#covTplName');
    nameInput.value = '';
    el.querySelector('#covTplSave').onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) { showToast('Give the template a name', 'error'); nameInput.focus(); return; }
        const mode = el.querySelector('input[name="covTplMode"]:checked').value;
        const items = mode === 'replace' ? replaceItems : addItems;
        if (!items.length) { showToast('There is nothing on this day to save', 'error'); return; }
        try {
            const res = await fetch('/api/event-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ businessId: state.business.id, name, mode, items }) });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);
            state.eventTemplates = data.templates || [];
            renderCoverageEditor();
            closeModalEl(el);
            showToast(`Template "${name}" saved. Apply it to any day from "Apply template".`, 'success');
        } catch (err) { showToast(err.message || 'Could not save the template', 'error'); }
    };
    openModalEl(el);
    setTimeout(() => nameInput.focus(), 50);
}

function openTemplatesModal() {
    const el = ensureModal('covTemplatesModal', `
        <div class="modal-overlay cov-modal" id="covTemplatesModal" style="display:none">
            <div class="modal-content">
                <div class="modal-header"><h2>Event templates</h2><button class="modal-close" data-close aria-label="Close">&times;</button></div>
                <div class="modal-body">
                    <p class="cov-modal-hint">Reusable staffing for days that happen more than once. Make one by editing a day, then "Save day as template".</p>
                    <div class="cov-tpl-list" id="covTplList"></div>
                </div>
                <div class="modal-footer"><button type="button" class="btn btn-primary" data-close>Done</button></div>
            </div>
        </div>`);
    const list = el.querySelector('#covTplList');
    const tpls = state.eventTemplates || [];
    list.innerHTML = tpls.length ? tpls.map(t => `
        <div class="cov-tpl" data-id="${escHtml(t.id)}">
            <div class="cov-tpl-main">
                <div class="cov-tpl-name">${escHtml(t.name)} <span class="cov-tpl-mode ${t.mode}">${t.mode === 'replace' ? 'replaces the day' : 'adds to the day'}</span></div>
                <div class="cov-tpl-items">${t.items.map(it => `<span class="cov-tpl-item"><i style="background:${escHtml(roleMap[it.role_id]?.color || '#64748b')}"></i>${t.mode === 'add' && it.count > 0 ? '+' : ''}${it.count} ${escHtml(roleMap[it.role_id]?.name || it.role_id)} · ${formatHour(it.start_hour)} – ${formatHour(it.end_hour)}</span>`).join('')}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm cov-tpl-delete" title="Delete this template">Delete</button>
        </div>`).join('') : '<div class="cov-tpl-empty">No templates yet.</div>';
    list.querySelectorAll('.cov-tpl-delete').forEach(btn => btn.onclick = async () => {
        const id = btn.closest('.cov-tpl').dataset.id;
        const t = tpls.find(x => x.id === id);
        if (!confirm(`Delete the "${t?.name || 'this'}" template? Days it was already applied to keep their changes.`)) return;
        try {
            const res = await fetch(`/api/event-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);
            state.eventTemplates = data.templates || [];
            renderCoverageEditor();
            openTemplatesModal();
        } catch (err) { showToast(err.message || 'Could not delete', 'error'); }
    });
    openModalEl(el);
}

// ==================== DATE EXCEPTIONS (manager) ====================

function formatExceptionDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeInputToHours(value) {
    if (!value) return null;
    const [h, m] = value.split(':').map(Number);
    return h + (m || 0) / 60;
}

/**
 * Shared exception modal. opts: { title, employeeName, onSave(payload) }
 * payload: {date, end_date, kind, all_day, start_hour, end_hour, note}
 */
function openExceptionModal(opts) {
    const el = ensureModal('exceptionModal', `
        <div class="modal-overlay cov-modal exc-modal" id="exceptionModal" style="display:none">
            <div class="modal-content modal-sm">
                <div class="modal-header"><h2 id="excTitle">Add a date exception</h2><button class="modal-close" data-close aria-label="Close">&times;</button></div>
                <div class="modal-body">
                    <p class="cov-modal-hint" id="excWho"></p>
                    <div class="exc-kind" role="radiogroup">
                        <button type="button" class="exc-kind-btn active" data-kind="unavailable">Can't work</button>
                        <button type="button" class="exc-kind-btn" data-kind="available">Can work</button>
                    </div>
                    <div class="cov-form-grid">
                        <label>Date<input type="date" id="excDate" class="form-input"></label>
                        <label>Through (optional)<input type="date" id="excEndDate" class="form-input"></label>
                    </div>
                    <label class="exc-allday"><input type="checkbox" id="excAllDay" checked> All day</label>
                    <div class="cov-form-grid" id="excTimes" hidden>
                        <label>From<input type="time" id="excStart" class="form-input" step="900"></label>
                        <label>Until<input type="time" id="excEnd" class="form-input" step="900"></label>
                    </div>
                    <label class="cov-field">Note (optional)<input type="text" id="excNote" class="form-input" placeholder="Dentist, covering for a friend, …" maxlength="120"></label>
                    <p class="cov-modal-hint">Only these dates change. The usual weekly availability stays the same.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="excSave">Save</button>
                </div>
            </div>
        </div>`);
    el.querySelector('#excTitle').textContent = opts.title || 'Add a date exception';
    el.querySelector('#excWho').textContent = opts.employeeName ? `For ${opts.employeeName}.` : '';
    let kind = 'unavailable';
    el.querySelectorAll('.exc-kind-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.kind === kind);
        b.onclick = () => { kind = b.dataset.kind; el.querySelectorAll('.exc-kind-btn').forEach(x => x.classList.toggle('active', x === b)); };
    });
    const dateEl = el.querySelector('#excDate'), endEl = el.querySelector('#excEndDate'), allDay = el.querySelector('#excAllDay');
    const times = el.querySelector('#excTimes'), startEl = el.querySelector('#excStart'), endTimeEl = el.querySelector('#excEnd'), note = el.querySelector('#excNote');
    const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    dateEl.min = iso; endEl.min = iso; dateEl.value = opts.date || ''; endEl.value = ''; allDay.checked = true; times.hidden = true;
    startEl.value = `${String(state.startHour).padStart(2, '0')}:00`; endTimeEl.value = `${String(Math.min(23, state.endHour)).padStart(2, '0')}:00`; note.value = '';
    allDay.onchange = () => { times.hidden = allDay.checked; };
    dateEl.onchange = () => { endEl.min = dateEl.value || iso; };
    el.querySelector('#excSave').onclick = async () => {
        if (!dateEl.value) { showToast('Pick a date', 'error'); dateEl.focus(); return; }
        const payload = { date: dateEl.value, end_date: endEl.value || null, kind, all_day: allDay.checked, note: note.value.trim() };
        if (!allDay.checked) {
            payload.start_hour = timeInputToHours(startEl.value); payload.end_hour = timeInputToHours(endTimeEl.value);
            if (payload.start_hour === null || payload.end_hour === null || payload.end_hour <= payload.start_hour) { showToast('The end time must be after the start time', 'error'); return; }
        }
        const ok = await opts.onSave(payload);
        if (ok !== false) closeModalEl(el);
    };
    openModalEl(el);
}

function exceptionRowHtml(e, deletable = true) {
    return `<div class="exc-item ${escHtml(e.kind)}" data-id="${escHtml(e.id)}">
        <span class="exc-item-date">${formatExceptionDate(e.date)}</span>
        <span class="exc-item-text"><strong>${e.kind === 'available' ? 'Can work' : "Can't work"}</strong> ${e.all_day ? 'all day' : `${formatHourMinute(e.start_hour)} – ${formatHourMinute(e.end_hour)}`}${e.note ? ` <span class="exc-item-note">· ${escHtml(e.note)}</span>` : ''}</span>
        <span class="exc-item-by">${e.created_by === 'employee' ? 'added by them' : 'added by you'}</span>
        ${deletable ? '<button type="button" class="exc-item-delete" title="Remove this exception" aria-label="Remove">&times;</button>' : ''}
    </div>`;
}

async function renderAvailabilityExceptions(empId) {
    const list = document.getElementById('availExceptionsList');
    const btn = document.getElementById('availAddExceptionBtn');
    if (!list) return;
    const emp = employeeMap[empId];
    if (btn) btn.onclick = () => openExceptionModal({
        employeeName: emp?.name,
        onSave: async (payload) => {
            try {
                const res = await fetch(`/api/employees/${encodeURIComponent(empId)}/exceptions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId: state.business.id, ...payload }) });
                const data = await res.json();
                if (!data.success) throw new Error(data.message);
                paintExceptions(data.exceptions || []);
                showToast('Date exception saved', 'success');
                loadWeekContext();
                return true;
            } catch (err) { showToast(err.message || 'Could not save', 'error'); return false; }
        },
    });
    const paintExceptions = (items) => {
        list.innerHTML = items.length ? items.map(e => exceptionRowHtml(e)).join('') : '<div class="exc-empty">No date exceptions. Their weekly availability applies every week.</div>';
        list.querySelectorAll('.exc-item-delete').forEach(b => b.onclick = async () => {
            const id = b.closest('.exc-item').dataset.id;
            try {
                const res = await fetch(`/api/employees/${encodeURIComponent(empId)}/exceptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
                const data = await res.json();
                if (!data.success) throw new Error(data.message);
                paintExceptions(data.exceptions || []);
                loadWeekContext();
            } catch (err) { showToast(err.message || 'Could not remove', 'error'); }
        });
    };
    list.innerHTML = '<div class="exc-empty">Loading…</div>';
    try {
        const res = await fetch(`/api/employees/${encodeURIComponent(empId)}/exceptions`);
        const data = await res.json();
        paintExceptions(data.exceptions || []);
    } catch (err) { list.innerHTML = '<div class="exc-empty">Could not load exceptions.</div>'; }
}

/** Hours (Set) after this week's date exceptions for one person on one day. */
function applyExceptionsToHours(empId, dayIdx, hours) {
    const excs = exceptionsForDate(dayIdx).filter(e => e.employee_id === empId);
    excs.forEach(e => {
        const lo = e.all_day ? state.startHour : Math.floor(e.start_hour);
        const hi = e.all_day ? state.endHour : Math.ceil(e.end_hour);
        for (let h = lo; h < hi; h++) {
            if (e.kind === 'available') hours.add(h); else hours.delete(h);
        }
    });
    return hours;
}

function employeeUnavailableAllDayByException(empId, dayIdx) {
    return exceptionsForDate(dayIdx).some(e => e.employee_id === empId && e.kind === 'unavailable' && e.all_day);
}

// ==================== WIRING ====================

document.addEventListener('DOMContentLoaded', () => {
    const editBtn = document.getElementById('editWeekBtn');
    if (editBtn) editBtn.addEventListener('click', () => setEditWeekMode(!state.editWeekMode));
    const doneBtn = document.getElementById('editWeekDoneBtn');
    if (doneBtn) doneBtn.addEventListener('click', () => setEditWeekMode(false));
    const resetBtn = document.getElementById('editWeekResetBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetWeekOverrides);
    const tplBtn = document.getElementById('editWeekTemplatesBtn');
    if (tplBtn) tplBtn.addEventListener('click', openTemplatesModal);
    const chip = document.getElementById('weekChangesChip');
    if (chip) chip.addEventListener('click', () => setEditWeekMode(true));
    // Generating from the editor: show the schedule as it builds
    if (dom.generateBtn) dom.generateBtn.addEventListener('click', () => setEditWeekMode(false));
    document.querySelectorAll('.view-toggle-btn').forEach(b => b.addEventListener('click', () => { if (state.editWeekMode) setEditWeekMode(false); }));
    updateWeekChangesChip();
});
