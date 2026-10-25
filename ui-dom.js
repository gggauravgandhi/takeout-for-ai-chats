// DOM helpers shared by popup.js and exporter.js. textContent only, never innerHTML.

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, type?: string, action?: string, id?: string }} [props]
 * @returns {HTMLElement}
 */
export function el(tag, { class: className, text, type, action, id } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (type) node.type = type;
  if (action) node.dataset.action = action;
  if (id) node.dataset.id = id;
  return node;
}

/**
 * Make the buttons inside `container` match `actions`, reusing existing buttons so focus and hover survive
 * the frequent re-renders while an export runs.
 * @param {HTMLElement} container
 * @param {Array<{ id: string, label: string, tone?: string, disabled?: boolean }>} actions
 */
export function syncButtons(container, actions) {
  const existing = new Map([...container.children].map((button) => [button.dataset.action, button]));
  const next = actions.map(({ id, label, tone = 'default', disabled = false }) => {
    const button = existing.get(id) ?? el('button', { type: 'button', action: id });
    if (button.textContent !== label) button.textContent = label;
    button.className = `btn btn-${tone}`;
    button.disabled = disabled;
    return button;
  });
  const same = next.length === container.children.length && next.every((button, i) => container.children[i] === button);
  if (!same) container.replaceChildren(...next);
}

/**
 * @param {HTMLElement} bar element with role="progressbar" whose first child is the fill
 * @param {number|null} percent 0-100, or null when unknown
 * @param {boolean} indeterminate show the moving bar instead of a value
 * @param {string} text spoken description of the progress
 */
export function setProgress(bar, percent, indeterminate, text) {
  bar.toggleAttribute('data-indeterminate', indeterminate);
  if (percent === null) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(percent));
  bar.setAttribute('aria-valuetext', text);
  bar.firstElementChild.style.transform = indeterminate ? '' : `scaleX(${(percent ?? 0) / 100})`;
}
