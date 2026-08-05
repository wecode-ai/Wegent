export const DESKTOP_CHAT_CONTENT_BASE_CLASS =
  'mx-auto min-w-0 px-0 transition-[width,max-width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'

export const DESKTOP_CHAT_CONTENT_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)]`

export const DESKTOP_MESSAGE_LIST_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_6rem))] max-w-[calc(100%_-_6rem)]`

export const DESKTOP_MESSAGE_LIST_CLASS = `${DESKTOP_MESSAGE_LIST_WIDTH_CLASS} px-0`
