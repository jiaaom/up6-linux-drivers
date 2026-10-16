// 设置 › 账号: sign in to fnOS (files and notifications need it), or, when
// signed in, who you are and 退出登录. The password goes to t6-paneld once;
// with 记住我 it seals it so the panel can sign itself in after a restart.

import { api } from '../../core/api.js';
import { html, on } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { confirm, toast } from '../../shell/layers.js';
import { resourceSubpage } from '../../ui/page.js';
import { errorLine, passwordField, textField, wireReveal } from '../../ui/fields.js';
import { actionRow, foot, list, note, section, switchRow } from '../../ui/settings.js';
import { forgetUser } from '../../data/session.js';
import { account } from '../../data/stores.js';

const remembered = (a) => !!a.autoLogin && a.autoLogin.user === a.username;

function signInForm() {
  return html`
    ${note(t('account.why'))}
    ${textField({ id: 't6-user', label: t('account.user'), autocomplete: 'username' })}
    ${passwordField({ id: 't6-pass', label: t('account.password'), style: 'margin-top:14px' })}
    ${errorLine()}
    ${list([switchRow({ label: t('account.remember'), subText: t('account.rememberSub'), checked: false, attrs: html` data-remember` })])}
    <button class="rl-btn rl-btn--primary rl-btn--block" style="margin:14px 0 16px" data-sign-in>${t('account.signIn')}</button>`;
}

function signedIn(a) {
  const keep = remembered(a);
  return html`
    <div class="rl-account">
      <span class="rl-set__avatar rl-set__avatar--lg" aria-hidden="true">${(a.username || '?')[0].toUpperCase()}</span>
      <div><p class="rl-account__name">${a.username}</p><p class="rl-account__role">${a.admin ? t('account.admin') : t('account.member')} · ${t('account.fnos')}</p></div>
    </div>
    ${section('account.secSession')}
    ${list([switchRow({ label: t('account.remember'), subText: keep ? t('account.rememberSub') : t('account.rememberAtSignIn'), checked: keep, disabled: !keep, attrs: html` data-forget` })])}
    ${list([actionRow({ iconName: 'sign-out', label: t('account.signOut'), danger: true, attrs: html` data-sign-out` })])}
    ${foot(t('account.signOutFoot'), 'margin-bottom:18px')}`;
}

export default function accountPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.account', res: account, body: (a) => (a.signedIn ? signedIn(a) : signInForm()) });
  const $ = (sel) => ctx.el.querySelector(sel);

  function showError(message) {
    const err = $('[data-error]');
    err.hidden = !message;
    err.querySelector('span').textContent = message || '';
    $('#t6-pass').toggleAttribute('aria-invalid', !!message);
  }

  async function signIn() {
    const user = $('#t6-user').value.trim();
    const password = $('#t6-pass').value;
    if (!user || !password) { showError(t('account.missing')); return; }
    showError('');
    const btn = $('[data-sign-in]');
    btn.disabled = true;
    btn.textContent = t('account.signingIn');
    try {
      const r = await api.post('fnos/login', { user, password, remember: $('[data-remember]').checked });
      document.activeElement?.blur();
      toast(r.autoLoginError ? t('account.signedInNoRemember') : t('account.signedInDone'));
      await account.refresh();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t('account.signIn');
      showError(e.unreachable ? t('account.noAnswer') : e.message || t('account.rejected'));
    }
  }

  on(ctx.el, 'click', '[data-sign-in]', signIn);
  on(ctx.el, 'keydown', '#t6-user', (e) => { if (e.key === 'Enter') $('#t6-pass').focus(); });
  on(ctx.el, 'keydown', '#t6-pass', (e) => { if (e.key === 'Enter') signIn(); });
  wireReveal(ctx.el);
  on(ctx.el, 'change', 'input[data-forget]', async (e, input) => {
    try {
      await api.del('fnos/auto-login');
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    account.refresh();
  });
  on(ctx.el, 'click', '[data-sign-out]', async () => {
    const ok = await confirm({ title: t('account.signOutTitle'), body: t('account.signOutBody'), action: t('account.signOut'), kind: 'danger', actionIcon: 'sign-out' });
    if (!ok) return;
    try {
      await api.post('fnos/logout');
      forgetUser();
      toast(t('account.signedOutDone'));
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    account.refresh();
  });

  return { title: 'page.account', render: page.render, show: () => account.refresh() };
}
