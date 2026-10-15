import { t } from './i18n.mjs';

export async function startNewConversation({ state, harness, key }) {
  await state.clearSession(key);
  const result = await harness.prepareConversationDirectory?.(key, { explicitNew: true });
  return [t('已开启全新 Harness 会话。'), result?.warning ? t(result.warning) : null].filter(Boolean).join('\n');
}
