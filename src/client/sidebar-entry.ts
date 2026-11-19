/**
 * 侧边栏顶部入口：把「技能中枢」行注入到 New Session 下方、插件族
 * （封装生成 / 符号生成 / 原理图生成 / 插件更新）之后。
 *
 * 宿主 ui-sidebar 只在侧边栏底部暴露 `sidebar.footer.action`，顶部这段
 * 没有任何插件可注册的插槽，因此与 封装生成 / 符号生成 采用同一套做法：
 * 直接往侧边栏 DOM 里插入一个普通按钮行，并靠 MutationObserver 自愈
 * （React 重渲染把行挤掉时在同一帧内重新插回，不闪）。
 *
 * 行本身是纯 DOM；点击只派发 `dsh-skill-manager:toggle` 事件，真正的
 * 弹窗由注册在 `shell.overlay` 插槽里的 React 组件负责，两者解耦。
 */

/** 行的稳定标识（幂等键）。 */
export const SKILL_MANAGER_ENTRY_ATTRIBUTE = 'data-dsh-skill-manager-entry'
export const SKILL_MANAGER_ENTRY_SELECTOR = `[${SKILL_MANAGER_ENTRY_ATTRIBUTE}]`

/** 点击行时派发的窗口事件名。 */
export const SKILL_MANAGER_TOGGLE_EVENT = 'dsh-skill-manager:toggle'

/** 已有插件族行的选择器：本行排在它们之后。 */
const FAMILY_SELECTORS = [
  '[data-hqcg-footprint-entry]',
  '[data-hqcg-symbol-entry]',
  '[data-hqcg-schematic-entry]',
  '[data-hq-dummy-entry]',
  '[data-hq-plugin-update-entry]',
] as const

/** 与宿主导航行同尺寸的技能图标（16×16，currentColor）。 */
const ICON = `
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z" fill="currentColor"/>
  <path d="M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33295 2.91984 1.47867 2.37225 1.82422 1.89649C2.02613 1.61864 2.27098 1.37379 2.54883 1.17188C3.02472 0.826181 3.57197 0.6806 4.20215 0.612307C4.81976 0.545393 5.594 0.546877 6.55371 0.546878H9.02246ZM9.19629 9.14649H4.5459V7.84571H9.19629V9.14649ZM11.0303 6.10645H4.5459V4.80567H11.0303V6.10645Z" fill="currentColor"/>
</svg>`

/** 行样式：与 封装生成 / 符号生成 行完全一致。 */
const ENTRY_CSS = `
.dshsm-sidebar-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 2px;
  min-height: 36px;
  padding: 7px 8px;
  background: transparent;
  border: none;
  border-radius: 12px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  line-height: 22px;
  text-align: left;
  white-space: nowrap;
}
.dshsm-sidebar-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshsm-sidebar-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshsm-sidebar-entry__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.dshsm-sidebar-entry__icon svg {
  display: block;
  width: 16px;
  height: 16px;
}
.dshsm-sidebar-entry__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-frame][data-sidebar-collapsed] .dshsm-sidebar-entry,
[data-sidebar-collapsed] .dshsm-sidebar-entry {
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] .dshsm-sidebar-entry__icon svg,
[data-sidebar-collapsed] .dshsm-sidebar-entry__icon svg {
  width: 18px;
  height: 18px;
}
[data-dsh-frame][data-sidebar-collapsed] .dshsm-sidebar-entry__label,
[data-sidebar-collapsed] .dshsm-sidebar-entry__label {
  display: none;
}
`

/** 样式只注入一次。 */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="dsh-skill-manager-sidebar"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-skill-manager-sidebar'
  tag.textContent = ENTRY_CSS
  document.head.appendChild(tag)
}

/** 找侧边栏 UI 根节点。 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** 找 New Session 按钮。 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** 把行插到插件族之后；族不存在时紧跟 New Session。 */
function place(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const logoRow = button.closest('[class*="logoRow"]')
    const base = (logoRow !== null && logoRow.parentElement === root) ? logoRow : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS.join(', ')),
    )
    const anchor = family.length > 0
      ? family[family.length - 1]!.nextElementSibling
      : base.nextElementSibling
    root.insertBefore(entry, anchor ?? null)
  }
  return true
}

/** 挂载选项。 */
export interface SidebarEntryOptions {
  label(): string
  tooltip?(): string
}

/**
 * 挂载顶部入口行，等待外壳渲染并自愈。
 * @param options - 标题文案来源。
 * @returns 移除行与观察器的清理函数。
 */
export function mountSkillManagerSidebarEntry(options: SidebarEntryOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(SKILL_MANAGER_ENTRY_SELECTOR) !== null) return () => {}
  injectStyles()

  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(SKILL_MANAGER_ENTRY_ATTRIBUTE, '')
  entry.setAttribute('data-dsh-plugin', 'dsh-skill-manager')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = 'dshsm-sidebar-entry'
  const iconSpan = document.createElement('span')
  iconSpan.className = 'dshsm-sidebar-entry__icon'
  iconSpan.innerHTML = ICON
  const labelSpan = document.createElement('span')
  labelSpan.className = 'dshsm-sidebar-entry__label'
  entry.append(iconSpan, labelSpan)

  const applyLabel = (): void => {
    const label = options.label()
    entry.setAttribute('aria-label', label)
    if (options.tooltip !== undefined) entry.setAttribute('title', options.tooltip())
    labelSpan.textContent = label
  }
  applyLabel()
  entry.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent(SKILL_MANAGER_TOGGLE_EVENT))
  })

  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed && document.body.contains(entry)) return
    if (placed) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = place(root, entry)
    if (placed) {
      applyLabel()
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = place(root, entry)
  })

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    entry.remove()
  }
}
