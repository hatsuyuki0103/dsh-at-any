/**
 * The `at-file` settings namespace: the durable enable switch and file-name
 * filters managed from the Web settings page. Registered with the settings
 * provider at plugin load; the runtime reads the owner scope's live value on
 * every call, so changes take effect without a restart.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { AtFileSettings } from './contract.ts'
import type { FileIgnoreRule } from './contract.ts'
import { DEFAULT_IGNORE_FILES } from './defaults.ts'

/**
 * The settings namespace name (the Web allowlist must list the same string).
 * Note: dsh-settings >= 0.1.2-rc.1 移除了 settingsNamespace() 导出，
 * 改用 SettingsNamespaceInput 裸字符串收窄（register/get/update 直接接受字符串）。
 */
export const AT_FILE_NAMESPACE = 'at-file'

/** Schemastery schema of the `at-file` namespace section. */
export const AtFileSettingsSchema: z<AtFileSettings> = z.object({
  enabled: z.boolean().default(true),
  ignoreFiles: z.array(z.union([
    z.string(),
    z.object({
      kind: z.union(['exact', 'regex'] as const),
      pattern: z.string(),
      caseSensitive: z.boolean(),
    }) as z<FileIgnoreRule>,
  ])).default([...DEFAULT_IGNORE_FILES]),
  workspaceIgnoreFiles: z.array(z.object({
    workspace: z.string(),
    ignoreFiles: z.array(z.union([
      z.string(),
      z.object({
        kind: z.union(['exact', 'regex'] as const),
        pattern: z.string(),
        caseSensitive: z.boolean(),
      }) as z<FileIgnoreRule>,
    ])),
  })).default([]),
})

/**
 * Register the namespace with the settings provider and return its owner scope.
 * @param ctx - the plugin context carrying the settings provider.
 * @returns the owner scope backing the runtime's live enable check.
 */
export function registerAtFileSettings(ctx: Context): SettingsScope<AtFileSettings> {
  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: 'live' })
}
