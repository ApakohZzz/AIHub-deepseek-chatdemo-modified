import { useEffect, useState } from 'react'
import { getFileViewType, isImage } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'
import { useWorkspaceSync } from '../../services/workspace.js'

const readSvgThumbnail = (original: Blob) => {
  const svg = original.slice(0, original.size, 'image/svg+xml')
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(svg)
  })
}

type FileView = {
  url: string | null
  link: { href: string; target: '_blank'; rel: 'noreferrer' } | { href: string; download: string }
}

/** 草稿传 File，已发送的附件传 IndexedDB 原件 ID。 */
export const useFileView = (source: File | string, name: string) => {
  const type = getFileViewType(name)
  const image = isImage(type)
  const svg = type === 'image/svg+xml'
  const openInTab = type === 'application/pdf' || (image && !svg)
  const fileEpoch = useWorkspaceSync((state) => typeof source === 'string' ? state.fileEpoch : 0)
  const [state, setState] = useState<{ source: File | string; name: string; view: FileView | null }>()

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    const original = typeof source === 'string' ? loadFile(source) : Promise.resolve(source)
    void original
      .then(async (blob) => {
        if (!active || !blob) return
        // SVG 缩略图使用独立的 data URL，下载地址统一使用二进制 MIME。
        const thumbnail = svg ? await readSvgThumbnail(blob).catch(() => null) : null
        if (!active) return
        objectUrl = URL.createObjectURL(
          blob.slice(0, blob.size, openInTab ? type : 'application/octet-stream')
        )
        setState({
          source,
          name,
          view: {
            url: svg ? thumbnail : image ? objectUrl : null,
            link: openInTab
              ? { href: objectUrl, target: '_blank', rel: 'noreferrer' }
              : { href: objectUrl, download: name },
          },
        })
      })
      .catch(() => {})
      .finally(() => {
        if (active && !objectUrl) setState({ source, name, view: null })
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source, name, type, image, svg, openInTab, fileEpoch])

  const current = state?.source === source && state.name === name ? state : undefined
  return { url: current ? current.view?.url ?? null : undefined, image, link: current?.view?.link }
}
