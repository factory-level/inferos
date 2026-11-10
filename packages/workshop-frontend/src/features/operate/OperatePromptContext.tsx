import { createContext, useContext } from 'react'

/**
 * How a widget on the Operate page puts a prompt in the person's own chat (FAC-98): as a draft in
 * the composer, never sent for them. The Operate page provides it; outside an Operate page there is
 * none, and a widget's prompt goes nowhere.
 */
const OperatePromptContext = createContext<((text: string) => void) | null>(null)

/** Provides `insertDraft` to the widgets under it. */
export const OperatePromptProvider = OperatePromptContext.Provider

/** The Operate page's `insertDraft`, or null outside one. */
export const useInsertOperatePrompt = () => useContext(OperatePromptContext)
