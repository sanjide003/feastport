// id-card-renderer.js
// Shared Lanyard Participant ID Card Renderer & Public QR Verification Token Utilities

import { readableTextColor, teamColor } from './fest-config.js';
import { currentYear } from './branding-config.js';
import { renderQrSvg } from './qr-svg.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeAccentOnLight(color = '#1D4ED8') {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '1D4ED8';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 < 145 ? `#${hex}` : '#0F172A';
}

function accentTintSurface(color = '#1D4ED8') {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '1D4ED8';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return {
    bg: `rgba(${r}, ${g}, ${b}, 0.08)`,
    border: `rgba(${r}, ${g}, ${b}, 0.24)`
  };
}

export function formatChestNumber(chestNo) {
  const clean = String(chestNo ?? '').trim().replace(/^#+/, '');
  return clean || '—';
}

function fnv1a32(input, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function computeVerificationToken(student = {}) {
  const id = String(student.id || '').trim();
  const chest = formatChestNumber(student.chestNo);
  const chestNorm = chest === '—' ? '' : chest.toUpperCase();
  const team = String(student.team || '').trim();
  const name = String(student.name || '').trim().toUpperCase();
  const canonical = `FESTPORT_ID_V1|${id}|${chestNorm}|${team}|${name}`;
  const partA = fnv1a32(canonical, 0x811c9dc5).toString(36).toUpperCase().padStart(7, '0').slice(-4);
  const partB = fnv1a32(`${canonical}#SIG2`, 0x9e3779b1).toString(36).toUpperCase().padStart(7, '0').slice(-4);
  return `${partA}${partB}`;
}

export function buildVerificationUrl(student = {}, origin = '') {
  const rawOrigin = origin || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  const base = String(rawOrigin || '').replace(/\/+$/, '');
  const chest = formatChestNumber(student.chestNo);
  const token = computeVerificationToken(student);
  const params = new URLSearchParams();
  if (chest !== '—') {
    params.set('c', chest);
  } else if (student.id) {
    params.set('ref', String(student.id));
  }
  params.set('k', token);
  const path = `/verify.html?${params.toString()}`;
  return base && /^https?:\/\//i.test(base) ? `${base}${path}` : path;
}

export function isValidImageSrc(value) {
  const src = String(value || '').trim();
  return /^data:image\/(jpeg|png|webp|gif);base64,/i.test(src) || /^https?:\/\//i.test(src);
}

export function renderParticipantIdCardHtml({
  student = {},
  confirmedEvents = [],
  branding = {},
  teamColors = {},
  teamDisplayNames = {},
  categoryDisplayNames = {},
  festYear = currentYear(),
  verificationUrl = '',
  flipped = false,
  hintText = 'Flip the badge to view confirmed competition entries and verification QR.'
} = {}) {
  const color = teamColor(student.team, teamColors);
  const headerFg = readableTextColor(color);
  const headerMuted = headerFg === '#FFFFFF' ? 'rgba(255,255,255,0.78)' : 'rgba(15,23,42,0.72)';
  const headerSurface = headerFg === '#FFFFFF' ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.08)';
  const headerBorder = headerFg === '#FFFFFF' ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.18)';
  const accentOnWhite = safeAccentOnLight(color);
  const badgeTint = accentTintSurface(accentOnWhite);

  const teamLabel = teamDisplayNames[student.team] || student.team || 'Team';
  const categoryLabel = categoryDisplayNames[student.category] || student.category || 'General';
  const genderLabel = student.gender || 'Boys';
  const classLabel = student.details?.class || student.class || '—';
  const chestLabel = formatChestNumber(student.chestNo);
  const studentInitial = String(student.name || 'S').trim()[0]?.toUpperCase() || 'S';

  const festTitle = String(branding.festName1 || '').trim() || 'Fest Management';
  const festSub = branding.festName2 && branding.festName2 !== 'Setup Required' ? String(branding.festName2).trim() : '';
  const festFullTitle = festSub ? `${festTitle} ${festSub}` : festTitle;
  const festInitials = festTitle.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'FM';
  const hasLogo = isValidImageSrc(branding.logoUrl);
  const hasPhoto = isValidImageSrc(student.photoData);

  const qrTargetUrl = verificationUrl || buildVerificationUrl(student);
  const qrSvg = renderQrSvg(qrTargetUrl, {
    sizePx: 88,
    quietZone: 2,
    fg: '#0F172A',
    bg: '#FFFFFF',
    label: `Verification QR code for ${student.name || 'Participant'} Chest ${chestLabel}`
  });

  const eventsHtml = confirmedEvents.length
    ? confirmedEvents.map((ev, idx) => `
        <div class="flex items-start gap-2.5 py-2.5 text-left">
          <span class="pt-0.5 font-mono-num text-[11px] font-bold text-slate-400">${String(idx + 1).padStart(2, '0')}.</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-semibold text-slate-900">${esc(ev.name)}</p>
            <p class="mt-0.5 truncate text-[11px] text-slate-500">${esc(ev.stage || 'On-Stage')} · ${esc(ev.type || 'Single')}${ev.date || ev.time ? ` · ${esc(ev.date || '')} ${esc(ev.time || '')}`.trim() : ''}${ev.venue ? ` · ${esc(ev.venue)}` : ''}</p>
          </div>
        </div>
      `).join('')
    : '<div class="py-8 text-center text-xs text-slate-400">No confirmed events yet. Approved competition entries will appear here.</div>';

  return `
    <div class="id-card-stage mx-auto">
      <div id="id-card-inner" class="id-card-inner${flipped ? ' is-flipped' : ''}">
        <!-- FRONT FACE -->
        <article id="id-card-front" class="id-card-face id-card-face-front flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div class="px-5 pt-3 pb-14" style="background:${esc(color)};color:${esc(headerFg)};border-bottom:1px solid ${esc(headerBorder)}">
            <div class="mx-auto mb-3.5 h-2.5 w-14 rounded-full border border-black/15 bg-[#F8FAFC] shadow-inner" aria-hidden="true"></div>
            <div class="flex items-center justify-between gap-3">
              <div class="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl font-display text-xs font-bold shadow-sm" style="background:${esc(headerSurface)};border:1px solid ${esc(headerBorder)}">
                <span>${esc(festInitials)}</span>
                ${hasLogo ? `<img src="${esc(branding.logoUrl)}" class="id-card-logo-img absolute inset-0 h-full w-full object-cover" alt="${esc(festFullTitle)}" referrerpolicy="no-referrer">` : ''}
              </div>
              <span class="font-mono-num text-[11px] font-semibold" style="color:${esc(headerMuted)}">${esc(festYear)}</span>
            </div>
          </div>

          <div class="-mt-11 px-5 pb-5 text-center">
            <div class="relative mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border-4 border-white bg-slate-100 font-display text-2xl font-bold shadow-sm" style="color:${esc(accentOnWhite)}">
              <span>${esc(studentInitial)}</span>
              ${hasPhoto ? `<img src="${esc(student.photoData)}" class="id-card-photo-img absolute inset-0 h-full w-full object-cover" alt="${esc(student.name)}" referrerpolicy="no-referrer">` : ''}
            </div>

            <h3 class="mt-3 font-display text-xl font-bold tracking-tight text-slate-900 text-balance">${esc(student.name)}</h3>
            <p class="mt-1 text-xs font-medium text-slate-500">
              <span>${esc(teamLabel)}</span>
              <span aria-hidden="true"> · </span>
              <span>${esc(categoryLabel)}</span>
            </p>

            <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
              <span class="block text-[10px] font-semibold uppercase tracking-widest text-slate-500">Chest Number</span>
              <span class="mt-0.5 block font-mono-num text-3xl font-extrabold tracking-tight" style="color:${esc(accentOnWhite)}">${esc(chestLabel)}</span>
            </div>

            <div class="mt-3 flex justify-center">
              <span class="inline-flex w-full items-center justify-center rounded-lg border px-4 py-1.5 font-display text-sm font-extrabold uppercase tracking-[0.22em]" style="background:${esc(badgeTint.bg)};border-color:${esc(badgeTint.border)};color:${esc(accentOnWhite)}">PARTICIPANT</span>
            </div>

            <div class="mt-4 grid grid-cols-2 border-y border-slate-200 text-left text-xs">
              <div class="border-b border-r border-slate-100 px-3 py-2.5">
                <span class="block text-[11px] text-slate-400">Team</span>
                <strong class="mt-0.5 block truncate font-semibold text-slate-900">${esc(teamLabel)}</strong>
              </div>
              <div class="border-b border-slate-100 px-3 py-2.5">
                <span class="block text-[11px] text-slate-400">Category</span>
                <strong class="mt-0.5 block truncate font-semibold text-slate-900">${esc(categoryLabel)}</strong>
              </div>
              <div class="border-r border-slate-100 px-3 py-2.5">
                <span class="block text-[11px] text-slate-400">Gender</span>
                <strong class="mt-0.5 block font-semibold text-slate-900">${esc(genderLabel)}</strong>
              </div>
              <div class="px-3 py-2.5">
                <span class="block text-[11px] text-slate-400">Class</span>
                <strong class="mt-0.5 block font-semibold text-slate-900">${esc(classLabel)}</strong>
              </div>
            </div>
          </div>

          <div class="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
            <div class="min-w-0 flex-1 text-left">
              <p class="truncate font-display text-xs font-bold text-slate-900">${esc(festFullTitle)}</p>
              <p class="mt-0.5 truncate font-mono-num text-[11px] font-medium text-slate-500">${esc(festYear)} · ${confirmedEvents.length} Confirmed Event${confirmedEvents.length === 1 ? '' : 's'}</p>
            </div>
            <button type="button" data-flip-id-card aria-pressed="${flipped ? 'true' : 'false'}" class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800">
              <i data-lucide="rotate-cw" class="h-3.5 w-3.5"></i>
              <span>Events &amp; QR</span>
            </button>
          </div>
        </article>

        <!-- BACK FACE -->
        <article id="id-card-back" class="id-card-face id-card-face-back flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div class="px-5 pt-3 pb-3.5" style="background:${esc(color)};color:${esc(headerFg)};border-bottom:1px solid ${esc(headerBorder)}">
            <div class="mx-auto mb-3 h-2.5 w-14 rounded-full border border-black/15 bg-[#F8FAFC] shadow-inner" aria-hidden="true"></div>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0 text-left">
                <p class="truncate font-display text-sm font-bold leading-tight">${esc(student.name)}</p>
                <p class="truncate text-[11px] font-medium" style="color:${esc(headerMuted)}">${esc(teamLabel)} · ${esc(categoryLabel)}</p>
              </div>
              <span class="shrink-0 font-mono-num text-sm font-extrabold">${esc(chestLabel)}</span>
            </div>
          </div>

          <div class="flex min-h-0 flex-1 flex-col px-5 pt-3.5 pb-3">
            <div class="flex items-center justify-between border-b border-slate-100 pb-2">
              <span class="text-xs font-bold uppercase tracking-wider text-slate-700">Confirmed Events</span>
              <span class="font-mono-num text-xs font-bold text-slate-500">${confirmedEvents.length}</span>
            </div>
            <div class="mt-1 max-h-[205px] flex-1 divide-y divide-slate-100 overflow-y-auto pr-1">
              ${eventsHtml}
            </div>

            <div class="mt-3 flex items-center gap-3.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div class="shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-1">
                ${qrSvg}
              </div>
              <div class="min-w-0 flex-1 text-left">
                <p class="text-[11px] font-bold uppercase tracking-wider text-slate-700">Verification Badge</p>
                <p class="mt-0.5 font-mono-num text-xs font-bold text-slate-900">Chest ${esc(chestLabel)}</p>
                <p class="mt-0.5 truncate text-xs font-semibold text-slate-700">${esc(teamLabel)}</p>
                <p class="mt-1 text-[11px] text-slate-500">Scan QR to verify official badge</p>
              </div>
            </div>
          </div>

          <div class="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
            <span class="truncate font-display text-[11px] font-semibold text-slate-600">${esc(festFullTitle)} · <span class="font-mono-num font-normal text-slate-500">${esc(festYear)}</span></span>
            <button type="button" data-flip-id-card aria-pressed="${flipped ? 'true' : 'false'}" class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100">
              <i data-lucide="rotate-ccw" class="h-3.5 w-3.5"></i>
              <span>Front ID</span>
            </button>
          </div>
        </article>
      </div>
    </div>
    ${hintText ? `<p class="mt-3 text-center text-xs text-slate-400">${esc(hintText)}</p>` : ''}
  `;
}

export function attachIdCardInteractions(container, { initialFlipped = false, onFlip = null } = {}) {
  if (!container) return;
  let flipped = Boolean(initialFlipped);

  const sync = (focusVisibleToggle = false) => {
    const inner = container.querySelector('#id-card-inner');
    const front = container.querySelector('#id-card-front');
    const back = container.querySelector('#id-card-back');
    if (!inner || !front || !back) return;
    inner.classList.toggle('is-flipped', flipped);
    front.setAttribute('aria-hidden', String(flipped));
    back.setAttribute('aria-hidden', String(!flipped));
    if ('inert' in front) {
      front.inert = flipped;
      back.inert = !flipped;
    }
    if (focusVisibleToggle) {
      const target = (flipped ? back : front).querySelector('[data-flip-id-card]');
      target?.focus?.();
    }
  };

  container.querySelectorAll('.id-card-logo-img, .id-card-photo-img').forEach((img) => {
    img.addEventListener('error', () => img.classList.add('hidden'), { once: true });
  });

  container.querySelectorAll('[data-flip-id-card]').forEach((btn) => {
    btn.addEventListener('click', () => {
      flipped = !flipped;
      sync(true);
      if (typeof onFlip === 'function') onFlip(flipped);
    });
  });

  sync(false);
}
