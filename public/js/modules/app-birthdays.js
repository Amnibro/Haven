// ═══════════════════════════════════════════════════════════
// Birthdays (#5788).
//
// The 🎉 beside a member's name on their birthday, the birthday line on
// profile cards, and the confetti a card opens with on the day.
// ═══════════════════════════════════════════════════════════

export default {

// ── Birthdays ─────────────────────────────────────────────
// Member lists carry a birthday as MM-DD, and profiles do too unless the owner
// turned off Hide birth year, which makes it YYYY-MM-DD. "Today" is the reader's
// date in their confirmed timezone, and a Feb 29 birthday is kept on Feb 28 in
// common years.

/** Days until the next birthday (0 on the day), or null without one. */
_daysUntilBirthday(birthday) {
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(birthday || '');
  if (!m) return null;
  const month = Number(m[1]) - 1, day = Number(m[2]);
  const occurrence = (year) => {
    const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
    return Date.UTC(year, month, month === 1 && day === 29 && !leap ? 28 : day);
  };
  const now = this._nowZonedParts();
  const today = Date.UTC(now.year, now.monthIndex, now.day);
  let next = occurrence(now.year);
  if (next < today) next = occurrence(now.year + 1);
  return Math.round((next - today) / 86400000);
},

/** "Oct 14 (in 5 days)", or "Oct 14 (Today)" on the day, followed by
 *  "(22 years old)" when the birth year is shown. */
_birthdayLabel(birthday) {
  const days = this._daysUntilBirthday(birthday);
  if (days === null) return '';
  const [month, day] = birthday.slice(-5).split('-').map(Number);
  const date = this._fmtDate(Date.UTC(2000, month - 1, day), { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = days === 0
    ? t('users.birthday_today', { date })
    : t(days === 1 ? 'users.birthday_in_days_one' : 'users.birthday_in_days_other', { date, count: days });
  if (birthday.length !== 10) return label;
  // Age on the next birthday, less one until it arrives.
  const now = this._nowZonedParts();
  const nextYear = new Date(Date.UTC(now.year, now.monthIndex, now.day + days)).getUTCFullYear();
  const age = nextYear - Number(birthday.slice(0, 4)) - (days === 0 ? 0 : 1);
  return `${label} ${t(age === 1 ? 'users.birthday_age_one' : 'users.birthday_age_other', { count: age })}`;
},

/** The 🎉 in front of a member's name on their birthday. It sits beside the
 *  name rather than in it, so nicknames and display names never change. */
_birthdayMarkHtml(birthday) {
  return this._daysUntilBirthday(birthday) === 0 ? '<span class="birthday-mark">🎉</span>' : '';
},

// The 🎉 in front of authors follows the member lists, so it appears on
// messages already on screen the moment someone sets today as their birthday.
_syncBirthdayMarks() {
  const container = document.getElementById('messages');
  if (!container) return;
  if (!(this._lastOnlineUsers || []).length && !(this.channelMembers || []).length) return;
  container.querySelectorAll('.message[data-user-id]').forEach(el => {
    if (el.dataset.personaId || el.classList.contains('webhook-message') || el.classList.contains('imported-message')) return;
    const author = el.querySelector('.message-header .message-author');
    if (!author) return;
    const prev = author.previousElementSibling;
    const mark = prev && prev.classList.contains('birthday-mark') ? prev : null;
    const html = this._birthdayMarkHtml(this._memberById(el.dataset.userId)?.birthday);
    if (html && !mark) author.insertAdjacentHTML('beforebegin', html);
    else if (!html && mark) mark.remove();
  });
},

/** Twitter style shower of 🎉 falling from the top of a profile card to its
 *  bottom, kept inside the card. Skipped when Reduce motion is on. */
_rainBirthdayConfetti(popup) {
  if (this._motionReduced()) return;
  const rect = popup.getBoundingClientRect();
  const size = 24;  // largest piece, in px, so none hangs past the card's edges
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('span');
    piece.className = 'birthday-confetti';
    piece.textContent = '🎉';
    piece.style.fontSize = `${14 + Math.random() * (size - 14)}px`;
    document.body.appendChild(piece);
    const x = rect.left + Math.random() * (rect.width - size);
    const drift = (Math.random() - 0.5) * 40;
    const endX = Math.min(rect.right - size, Math.max(rect.left, x + drift));
    const spin = (Math.random() - 0.5) * 720;
    piece.animate([
      { transform: `translate(${x}px, ${rect.top}px) rotate(0deg)`, opacity: 1 },
      { opacity: 1, offset: 0.75 },
      { transform: `translate(${endX}px, ${rect.bottom - size}px) rotate(${spin}deg)`, opacity: 0 },
    ], {
      duration: 1400 + Math.random() * 1000,
      delay: Math.random() * 600,
      easing: 'cubic-bezier(0.25, 0.6, 0.5, 1)',
      fill: 'both',
    }).finished.finally(() => piece.remove());
  }
},

};
