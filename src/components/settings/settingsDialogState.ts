import { create } from 'zustand'
import {
  getProvider,
  getSelection,
  hasProviderKey,
  type ModelSelection,
} from '../../services/providers.js'

export type SettingsSection = 'general' | 'account' | 'data' | 'providers'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  opening: 0,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState((state) => ({
    open: true,
    section,
    opening: state.open ? state.opening : state.opening + 1,
  }))

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开「模型供应商」，返回是否已有 Key */
export const ensureApiKey = (selection?: ModelSelection) => {
  if (hasProviderKey(getProvider(getSelection(selection).providerId))) {
    return true
  }
  openSettings('providers')
  return false
}
