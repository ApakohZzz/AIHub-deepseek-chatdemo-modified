import deepseek from '../../assets/provider-deepseek.svg'
import openai from '../../assets/provider-openai.svg'
import { providerPresets, type ProviderProfile } from '../../services/providers.js'
import { IconCubeOutline16 } from '../base/icons.js'
import styles from './Brand.module.css'

const icons = { deepseek, openai }

export const ProviderIcon = ({
  provider,
}: {
  provider?: Pick<ProviderProfile, 'protocol' | 'baseUrl'>
}) =>
  provider && provider.baseUrl === providerPresets[provider.protocol].baseUrl ? (
    <img
      className={styles.providerIcon}
      data-provider={provider.protocol}
      src={icons[provider.protocol]}
      alt=""
      width="16"
      height="16"
    />
  ) : (
    <IconCubeOutline16 />
  )
