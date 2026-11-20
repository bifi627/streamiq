import { useQuery } from '@tanstack/react-query'

/** uqr's SVG of url, loaded on demand so the main bundle doesn't carry it; null until then or if loading fails. */
export const useQrSvg = (url: string) =>
  useQuery({
    queryKey: ['qr', url],
    queryFn: async () => {
      const { renderSVG } = await import('uqr')
      // Fixed black on white with the spec's 4-module quiet zone: phone cameras need the contrast in either theme.
      return renderSVG(url, { border: 4 }).replace(
        '<svg ',
        `<svg role="img" aria-label="QR code of this page's address" `,
      )
    },
    staleTime: Infinity,
  }).data ?? null
