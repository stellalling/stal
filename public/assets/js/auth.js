import { api, escapeHtml, $, toast } from './common.js';

const state = { config: null, sending: false };

function showTab(name) {
  for (const btn of document.querySelectorAll('.auth-tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  $('#form-login').classList.toggle('hidden', name !== 'login');
  $('#form-register').classList.toggle('hidden', name !== 'register');
  $('#form-reset').classList.toggle('hidden', name !== 'reset');
}

document.querySelectorAll('.auth-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
document.querySelectorAll('[data-goto]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showTab(link.dataset.goto);
  });
});

function nextUrl() {
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  return next && next.startsWith('/') ? next : '/home.html';
}

/* 验证码按钮：60 秒倒计时，避免频繁请求 SMTP */
function bindSendCode(buttonId, emailId, purpose, hintId) {
  const button = $(buttonId);
  const input = $(emailId);
  const hint = hintId ? $(hintId) : null;
  let timer = null;

  button.addEventListener('click', async () => {
    const email = input.value.trim();
    if (!/.+@.+\..+/.test(email)) {
      toast('请输入正确的邮箱地址', 'error');
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = '发送中…';
    try {
      const res = await api('/api/auth/code', { method: 'POST', body: { email, purpose } });
      if (res.devCode) {
        if (hint) hint.innerHTML = `SMTP 未配置，本次验证码为 <strong class="mono">${escapeHtml(res.devCode)}</strong>（仅本地调试用）`;
        toast(res.message || '验证码已生成（未发送邮件）', 'info', 7000);
      } else {
        if (hint) hint.textContent = '验证码已发送，请查收（含垃圾箱）';
        toast(res.message || '验证码已发送', 'success');
      }
      let left = 60;
      button.textContent = `${left}s 后重发`;
      timer = setInterval(() => {
        left -= 1;
        button.textContent = `${left}s 后重发`;
        if (left <= 0) {
          clearInterval(timer);
          button.disabled = false;
          button.textContent = '获取验证码';
        }
      }, 1000);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = '获取验证码';
    }
  });
}

bindSendCode('#reg-send', '#reg-email', 'register', '#reg-hint');
bindSendCode('#reset-send', '#reset-email', 'reset', null);

$('#form-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = '登录中…';
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#login-email').value.trim(), password: $('#login-password').value },
    });
    toast('登录成功，正在进入主页…', 'success');
    setTimeout(() => { location.href = nextUrl(); }, 350);
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = '登录';
  }
});

$('#form-register').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#reg-password').value;
  if (password !== $('#reg-password2').value) {
    toast('两次输入的密码不一致', 'error');
    return;
  }
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = '注册中…';
  try {
    await api('/api/auth/register', {
      method: 'POST',
      body: { email: $('#reg-email').value.trim(), code: $('#reg-code').value.trim(), password },
    });
    toast('注册成功，正在进入主页…', 'success');
    setTimeout(() => { location.href = '/home.html'; }, 350);
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = '注册并登录';
  }
});

$('#form-reset').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    await api('/api/auth/reset', {
      method: 'POST',
      body: {
        email: $('#reset-email').value.trim(),
        code: $('#reset-code').value.trim(),
        password: $('#reset-password').value,
      },
    });
    toast('密码已重置，请使用新密码登录', 'success');
    showTab('login');
    $('#login-email').value = $('#reset-email').value.trim();
    $('#login-password').focus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '重置密码';
  }
});

async function init() {
  try {
    const boot = await api('/api/bootstrap');
    state.config = boot.config;
    $('#site-name').textContent = boot.config.site.name;
    if (boot.config.site.tagline) $('#site-tagline').textContent = boot.config.site.tagline;
    if (!boot.config.smtp.configured) {
      const notice = $('#smtp-notice');
      notice.style.display = 'flex';
      notice.innerHTML = '<span>⚠️</span><div>服务器尚未配置发件邮箱（<code class="mono">smtp.user</code>）。此时验证码不会真的发信，只会打印到服务器控制台，因此注册 / 找回密码暂时无法完成。</div>';
    }
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'error');
  }
}

init();
