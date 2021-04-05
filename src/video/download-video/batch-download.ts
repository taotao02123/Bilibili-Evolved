import { formatTitle } from '../title'

const fragmentSplitFactor = 12
const dashExtensions = ['.mp4', '.m4a']

export interface BatchExtractorConfig {
  itemFilter: (item: BatchItem) => boolean
  api?: (aid: number | string, cid: number | string, quality?: number | string) => string
}
export interface BatchTitleParameter {
  [key: string]: string
  n: string
  ep: string
}
interface BatchItem {
  aid: number | string
  cid: number | string
  titleParameters?: BatchTitleParameter
  title: string
}
export interface RawItemFragment { length: number, size: number, url: string }
export interface RawItem {
  fragments: RawItemFragment[]
  title: string
  totalSize: number
  cid: number | string
  referer: string
}
abstract class Batch {
  constructor(public config: BatchExtractorConfig) { }
  itemList: BatchItem[] = []
  abstract getItemList(): Promise<BatchItem[]>
  abstract collectData(quality: number | string): Promise<string>
  /**
   * Returns formated Title.
   *
   * @param parameters - TYPE: BatchTitleParameter
   * @returns escapeFilename
   *
   */
  static formatTitle(parameters: BatchTitleParameter | undefined) {
    const format = settings.batchFilenameFormat
    const title = formatTitle(format, true, parameters)
    return escapeFilename(title, ' ')
  }
  async getRawItems(quality: number | string): Promise<RawItem[]> {
    const { BannedResponse, throwBannedError } = await import('./batch-warning')
    try {
      const items = await this.collectData(quality)
      return JSON.parse(items)
    } catch (error) {
      if ((error as Error).message.includes(BannedResponse.toString())) {
        throwBannedError()
      }
      throw error
    }
  }
  extension(url: string, index: number) {
    const match = [
      '.flv',
      '.mp4'
    ].find(it => url.includes(it))
    if (match) {
      return match
    } else if (url.includes('.m4s')) {
      return dashExtensions[index]
    } else {
      return '.flv'
    }
  }
  async collectAria2(quality: number | string, rpc: boolean) {
    const json = await this.getRawItems(quality)
    const { getNumber } = await import('./get-number')
    if (rpc) {
      const option = settings.aria2RpcOption
      const { sendRpc, parseRpcOptions } = await import('./aria2-rpc')
      for (const item of json) {
        const params = item.fragments.map((fragment: { url: string }, index: number) => {
          let indexNumber = ''
          if (item.fragments.length > 1 && !fragment.url.includes('.m4s')) {
            indexNumber = ' - ' + getNumber(index + 1, item.fragments.length)
          }
          const params = []
          if (option.secretKey !== '') {
            params.push(`token:${option.secretKey}`)
          }
          params.push([fragment.url])
          params.push({
            referer: document.URL.replace(window.location.search, ''),
            'user-agent': UserAgent,
            out: `${item.title}${indexNumber}${this.extension(fragment.url, index)}`,
            split: fragmentSplitFactor,
            dir: option.dir || undefined,
            ...parseRpcOptions(option.other),
          })
          const id = encodeURIComponent(`${item.title}${indexNumber}`)
          return {
            params,
            id,
          }
        })
        await sendRpc(params, true)
      }
    } else {
      return `
# Generated by Bilibili Evolved Video Export
# https://github.com/the1812/Bilibili-Evolved/
${json.map(item => {
        return item.fragments.map((f, index) => {
          let indexNumber = ''
          if (item.fragments.length > 1 && !f.url.includes('.m4s')) {
            indexNumber = ` - ${getNumber(index + 1, item.fragments.length)}`
          }
          return `
${f.url}
  referer=${item.referer}
  user-agent=${UserAgent}
  out=${item.title}${indexNumber}${this.extension(f.url, index)}
  split=${fragmentSplitFactor}
   `.trim()
        }).join('\n')
      }).join('\n')}
      `.trim()
    }
  }
}
class VideoEpisodeBatch extends Batch {
  aid = unsafeWindow.aid!
  static async test() {
    if (document.URL.startsWith('https://www.bilibili.com/video/')) {
      return await SpinQuery.select('#multi_page') !== null
    }
    return false
  }
  async getItemList() {
    if (this.itemList.length > 0) {
      return this.itemList
    }
    const api = `https://api.bilibili.com/x/web-interface/view?aid=${this.aid}`
    const json = await Ajax.getJson(api)
    if (json.code !== 0) {
      Toast.error(`获取视频选集列表失败, message=${json.message}`, '批量下载')
      return []
    }
    const pages = json.data.pages
    if (pages === undefined) {
      Toast.error(`获取视频选集列表失败, 没有找到选集信息.`, '批量下载')
      return []
    }
    const { getNumber } = await import('./get-number')
    this.itemList = pages.map((page: any) => {
      return {
        title: `P${page.page} ${page.part}`,
        titleParameters: {
          n: getNumber(page.page, this.itemList.length),
          ep: page.part
        },
        cid: page.cid,
        aid: this.aid,
      } as BatchItem
    })
    return this.itemList
  }
  async collectData(quality: number | string) {
    const result = []
    for (const item of (await this.getItemList()).filter(this.config.itemFilter)) {
      const url = this.config.api ? this.config.api(item.aid, item.cid, quality) : `https://api.bilibili.com/x/player/playurl?avid=${item.aid}&cid=${item.cid}&qn=${quality}&otype=json`
      const json = await Ajax.getJsonWithCredentials(url)
      const data = json.data || json.result || json
      if (data.quality !== quality) {
        console.warn(`${item.title} 不支持所选画质, 已回退到较低画质. (quality=${data.quality})`)
      }
      let fragments: RawItemFragment[]
      if (data.durl) {
        fragments = data.durl.map((it: any) => {
          return {
            length: it.length,
            size: it.size,
            url: it.url
          }
        })
      } else if (data.dash) {
        const { getDashInfo, dashToFragments } = await import('./video-dash')
        const info = await getDashInfo(url, typeof quality === 'string' ? parseInt(quality) : quality, true)
        fragments = dashToFragments(info)
      } else {
        throw new Error(`获取链接失败: ${json.code} ${json.message}`)
      }
      result.push({
        fragments,
        // title: item.title.replace(/[\/\\:\*\?"<>\|]/g, ' '),
        title: Batch.formatTitle(item.titleParameters),
        totalSize: fragments.map(it => it.size).reduce((acc, it) => acc + it),
        cid: item.cid,
        referer: document.URL.replace(window.location.search, '')
      })
    }
    return JSON.stringify(result)
  }
}
class Bnj2020Batch extends Batch {
  mainVideo: VideoEpisodeBatch
  spVideo: VideoEpisodeBatch
  constructor(config: BatchExtractorConfig) {
    super(config)
    // 拜年祭就硬编码 aid 了(
    this.mainVideo = new VideoEpisodeBatch(config)
    this.mainVideo.aid = '78976165'
    this.spVideo = new VideoEpisodeBatch(config)
    this.spVideo.aid = '78979124'
  }
  static async test() {
    return document.URL.includes('//www.bilibili.com/blackboard/bnj2020.html')
  }
  async getItemList() {
    return (await this.mainVideo.getItemList()).concat(await this.spVideo.getItemList())
  }
  async collectData(quality: string | number) {
    return (await this.mainVideo.collectData(quality)).concat(await this.spVideo.collectData(quality))
  }
}
class Bnj2021Batch extends VideoEpisodeBatch {
  videos = _.get(unsafeWindow, '__INITIAL_STATE__.videoSections', [])
    .map((it: any) => it.episodes)
    .flat() as {
      aid: number
      cid: number
      title: string
    }[]
  constructor(public config: BatchExtractorConfig) {
    super(config)
  }
  static async test() {
    return document.URL.includes('//www.bilibili.com/festival/2021bnj')
  }
  async getItemList() {
    const { getNumber } = await import('./get-number')
    return this.videos.map(({ aid, cid, title }, index) => {
      return {
        title: `P${index + 1} ${title}`,
        titleParameters: {
          n: getNumber(index + 1, this.videos.length),
          ep: title,
        },
        aid,
        cid,
      } as BatchItem
    })
  }
}
class BangumiBatch extends Batch {
  static async test() {
    return document.URL.includes('/www.bilibili.com/bangumi')
  }
  /**
   * Get bangumi from api
   *
   * @returns a json list of multiple part bangumi
   *
   */
  async getItemList() {
    if (this.itemList.length > 0) {
      return this.itemList
    }
    const metaUrl = document.querySelector("meta[property='og:url']")
    if (metaUrl === null) {
      Toast.error('获取番剧数据失败: 无法找到 Season ID', '批量下载')
      return []
    }
    const seasonId = metaUrl.getAttribute('content')!.match(/play\/ss(\d+)/)![1]
    if (seasonId === undefined) {
      Toast.error('获取番剧数据失败: 无法解析 Season ID', '批量下载')
      return []
    }
    const json = await Ajax.getJson(`https://api.bilibili.com/pgc/web/season/section?season_id=${seasonId}`)
    if (json.code !== 0) {
      Toast.error(`获取番剧数据失败: 无法获取番剧集数列表, message=${json.message}`, '批量下载')
      return []
    }
    const { getNumber } = await import('./get-number')
    this.itemList = json.result.main_section.episodes.map((it: any, index: number) => {
      const n: string = it.long_title ? it.title : (index + 1).toString()
      const title: string = it.long_title ? it.long_title : it.title
      return {
        aid: it.aid,
        cid: it.cid,
        title: `${n} - ${title}`,
        // title: it.long_title ? `${it.title} - ${it.long_title}` : `${index + 1} - ${it.title}`,
        titleParameters: {
          n: getNumber(parseFloat(n), this.itemList.length, it.title),
          ep: title,
        },
      } as BatchItem
    })
    return this.itemList
  }
  async collectData(quality: string | number) {
    const result = []
    for (const item of (await this.getItemList()).filter(this.config.itemFilter)) {
      const url = this.config.api ? this.config.api(item.aid, item.cid, quality) : `https://api.bilibili.com/pgc/player/web/playurl?avid=${item.aid}&cid=${item.cid}&qn=${quality}&otype=json`
      const json = await Ajax.getJsonWithCredentials(url)
      const data = json.data || json.result || json
      if (data.quality !== quality) {
        console.warn(`${item.title} 不支持所选画质, 已回退到较低画质. (quality=${data.quality})`)
      }
      let fragments: RawItemFragment[]
      if (data.durl) {
        fragments = data.durl.map((it: any) => {
          return {
            length: it.length,
            size: it.size,
            url: it.url
          }
        })
      } else {
        const { getDashInfo, dashToFragments } = await import('./video-dash')
        const info = await getDashInfo(url, typeof quality === 'string' ? parseInt(quality) : quality)
        fragments = dashToFragments(info)
      }
      result.push({
        fragments,
        // title: item.title.replace(/[\/\\:\*\?"<>\|]/g, ' '),
        title: Batch.formatTitle(item.titleParameters),
        totalSize: fragments.map(it => it.size).reduce((acc, it) => acc + it),
        cid: item.cid,
        referer: document.URL.replace(window.location.search, '')
      })
    }
    return JSON.stringify(result)
  }
}
export class ManualInputBatch extends VideoEpisodeBatch {
  items: string[] = []
  async getItemList() {
    const { VideoInfo } = await import('../video-info')
    const { getNumber } = await import('./get-number')
    const pages = await Promise.all(this.items.map(async aid => {
      const info = new VideoInfo(aid)
      await info.fetchInfo()
      return info.pages.map((p, index) => {
        return {
          aid,
          cid: p.cid,
          titleParameters: {
            aid,
            cid: p.cid.toString(),
            n: getNumber(index + 1, info.pages.length),
            ep: info.pages.length > 1 ? p.title : '',
            title: info.title,
          },
          title: `P${(index + 1)} ${p.title}`,
        }
      })
    }))
    console.log(_.flatten(_.cloneDeep(pages)))
    return _.flatten(pages)
  }
}

const extractors = [BangumiBatch, VideoEpisodeBatch, Bnj2020Batch, Bnj2021Batch]
let ExtractorClass: new (config: BatchExtractorConfig) => Batch
export class BatchExtractor {
  config: BatchExtractorConfig
  constructor(config?: BatchExtractorConfig) {
    this.config = Object.assign({
      itemFilter: () => true,
    }, config)
  }
  static async test() {
    for (const e of extractors) {
      if (await e.test() === true) {
        ExtractorClass = e
        return true
      }
    }
    return false
  }
  getExtractor() {
    if (ExtractorClass === null) {
      logError('[批量下载] 未找到合适的解析模块.')
      throw new Error(`[Batch Download] module not found.`)
    }
    const extractor = new ExtractorClass(this.config)
    return extractor
  }
  async getItemList() {
    const extractor = this.getExtractor()
    return await extractor.getItemList()
  }
  async getRawItems(format: { quality: number | string }) {
    const extractor = this.getExtractor()
    return await extractor.getRawItems(format.quality)
  }
  async collectData(format: { quality: number | string }, toast: Toast) {
    const extractor = this.getExtractor()
    const result = await extractor.collectData(format.quality)
    toast.dismiss()
    return result
  }
  async collectAria2(format: { quality: number | string }, toast: Toast, rpc: false): Promise<string>
  async collectAria2(format: { quality: number | string }, toast: Toast, rpc: true): Promise<undefined>
  async collectAria2(format: { quality: number | string }, toast: Toast, rpc = false) {
    const extractor = this.getExtractor()
    const result = await extractor.collectAria2(format.quality, rpc)
    toast.dismiss()
    return result
  }
  formatTitle(parameters: BatchTitleParameter | undefined) {
    return Batch.formatTitle(parameters)
  }
}
export default {
  export: {
    BatchExtractor,
    ManualInputBatch,
  }
}
