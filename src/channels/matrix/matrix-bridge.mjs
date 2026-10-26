import { createTextBridgeStatus, TextHarnessBridge } from '../shared/text-harness-bridge.mjs';
import { t } from '../shared/i18n.mjs';

export const MATRIX_DESCRIPTOR = Object.freeze({
  key: 'matrix',
  label: 'Matrix',
  connectionLabel: ' CS API 长轮询',
  mentionOnlyPrompt: () => t('你被单独 @ 唤醒了。请结合当前会话和提供的群聊上下文回应；若没有明确的问题，请询问用户需要什么帮助。'),
  reactions: Object.freeze({
    processing: '👀',
    success: '✔',
    error: '✕',
  }),
});

export class MatrixHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({ descriptor: MATRIX_DESCRIPTOR, ...options });
  }
}

export { createTextBridgeStatus as createMatrixBridgeStatus };
