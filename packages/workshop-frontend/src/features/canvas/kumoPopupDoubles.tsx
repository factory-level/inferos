/* eslint-disable react/react-in-jsx-scope */
// Test doubles for Kumo's menu, dialog and select. They are Base UI popups, which jsdom cannot
// open; what the board's tests need is their triggers, their content and the open state.
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from 'react'

const DialogState = createContext({ open: false, onOpenChange: (_open: boolean) => {} })
type Clickable = ReactElement<{ onClick?: () => void }>

/** Kumo with its menu, dialog and select replaced, for `vi.mock('@cloudflare/kumo', ...)`. */
export const withKumoPopupDoubles = <T extends object>(kumo: T) => ({
  ...kumo,
  DropdownMenu: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Trigger: ({ render }: { render: ReactElement }) => render,
    Content: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
    Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button type="button" role="menuitem" onClick={onClick}>{children}</button>,
  }),
  Dialog: Object.assign(({ children }: { children: ReactNode }) => useContext(DialogState).open ? <div role="dialog">{children}</div> : null, {
    Root: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) =>
      <DialogState.Provider value={{ open, onOpenChange }}>{children}</DialogState.Provider>,
    Trigger: ({ render }: { render: Clickable }) => {
      const { onOpenChange } = useContext(DialogState)
      return cloneElement(render, { onClick: () => onOpenChange(true) })
    },
    Close: ({ render }: { render: Clickable }) => {
      const { onOpenChange } = useContext(DialogState)
      return cloneElement(render, { onClick: () => onOpenChange(false) })
    },
    Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  }),
  Select: Object.assign(({ label, value, onValueChange, children }: {
    label: string; value: string; onValueChange: (value: string) => void; children: ReactNode
  }) => <label>{label}<select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select></label>, {
    Option: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  }),
})

const field = (dialog: HTMLElement, label: string) =>
  [...dialog.querySelectorAll('label')].find(element => element.textContent?.startsWith(label))?.control

/** The control labelled `label` in the open dialog under `root`. */
export const dialogField = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(root: ParentNode, label: string): T => {
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]')
  const control = dialog && field(dialog, label)
  if (!control) throw new Error(`No field labelled ${label} in an open dialog`)
  return control as T
}

/** Set a controlled field's value as typing would: React tracks the value, so through the native setter. */
export const setFieldValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
