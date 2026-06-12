// Shared client helpers for the 6-box OTP inputs and the 60s resend countdown.
// Used by login (sign-in OTP) and signup (email verification).

export function setupOtpInputs(root: HTMLElement, onComplete?: (code: string) => void) {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[data-otp]')];

  const value = () => inputs.map((i) => i.value).join('');
  const focusAt = (i: number) => inputs[Math.max(0, Math.min(inputs.length - 1, i))]?.focus();

  inputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && idx < inputs.length - 1) focusAt(idx + 1);
      if (value().length === inputs.length) onComplete?.(value());
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) focusAt(idx - 1);
      if (e.key === 'ArrowLeft') focusAt(idx - 1);
      if (e.key === 'ArrowRight') focusAt(idx + 1);
    });
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, inputs.length);
      digits.split('').forEach((d, i) => (inputs[i].value = d));
      focusAt(digits.length);
      if (value().length === inputs.length) onComplete?.(value());
    });
  });

  return {
    value,
    clear: () => {
      inputs.forEach((i) => (i.value = ''));
      focusAt(0);
    },
    focus: () => focusAt(0),
  };
}

// Disables `btn` for `seconds`, showing a live countdown, then re-enables it.
export function startCountdown(btn: HTMLButtonElement, seconds = 60, label = 'Resend code') {
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    btn.textContent = `Resend in ${left}s`;
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = label;
      clearInterval(timer);
    }
    left--;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
