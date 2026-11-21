import { useTranslate } from '../../i18n/index.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'
import {
  getProvider,
  getSelection,
  LEGACY_PROVIDER_ID,
  useProviders,
} from '../../services/providers.js'

/** 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止。 */
export const ReadAloudButton = ({
  messageId,
  text,
  providerId,
}: {
  messageId: string
  text: string
  providerId?: string
}) => {
  const t = useTranslate()
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  useProviders((state) => state.profiles)
  const provider = getProvider(
    getSelection({ providerId: providerId ?? LEGACY_PROVIDER_ID, model: '' }).providerId
  )
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() =>
        toggleReadAloud(
          messageId,
          text,
          (error) => showToast(describeReadAloudError(error)),
          provider
        )
      }
    />
  )
}
