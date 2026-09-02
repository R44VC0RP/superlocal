export function isTrackingImage(image: {
  src: string
  width?: string | null
  height?: string | null
  style?: { width?: string; height?: string; display?: string; visibility?: string; opacity?: string }
}): boolean {
  if (!/^https?:\/\//i.test(image.src)) return false
  const style = image.style ?? {}
  const tiny = [image.width, image.height, style.width, style.height].some((value) => {
    if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(value.trim())) return false
    return Number.parseFloat(value) <= 2
  })
  const sized = [image.width, image.height, style.width, style.height].some((value) => Number.parseFloat(value ?? '') > 2)
  // Large hidden artwork can be an alternate responsive or dark-mode logo.
  if (tiny || (!sized && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
    || (style.opacity?.trim() !== '' && Number(style.opacity) === 0)))) return true
  if (/(?:^|[\W_])(track|pixel|beacon|open)(?:[\W_]|$)/i.test(image.src)) return true
  try {
    const url = new URL(image.src)
    return url.hostname === 'awstrack.me' || url.hostname.endsWith('.awstrack.me')
      || ((url.hostname === 'twitter.com' || url.hostname === 'www.twitter.com') && url.pathname === '/i/ibis')
  } catch {
    return false
  }
}
