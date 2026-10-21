export type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop'

const nameStorage = 'pexydrop-device-name'
const adjectives = ['Amber', 'Brisk', 'Cedar', 'Coral', 'Dusky', 'Ember', 'Frost', 'Golden', 'Hazel', 'Indigo', 'Jade', 'Lunar', 'Maple', 'Misty', 'Olive', 'Pebble', 'Quiet', 'Rusty', 'Sage', 'Silver', 'Sunny', 'Velvet', 'Willow', 'Zesty']
const animals = ['Badger', 'Crane', 'Dolphin', 'Falcon', 'Fox', 'Gecko', 'Heron', 'Ibis', 'Koala', 'Lynx', 'Marten', 'Narwhal', 'Otter', 'Panda', 'Puffin', 'Quokka', 'Raven', 'Robin', 'Seal', 'Tiger', 'Turtle', 'Walrus', 'Wolf', 'Yak']

function pick<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

export function detectDevice(): DeviceKind {
  const agent = navigator.userAgent
  // iPadOS reports itself as a Mac, so touch support is the tell.
  if (/iPad|Tablet/i.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return 'tablet'
  if (/Android/i.test(agent) && !/Mobile/i.test(agent)) return 'tablet'
  if (/Mobi|iPhone|Android/i.test(agent)) return 'phone'
  return 'laptop'
}

export function describeDevice() {
  const agent = navigator.userAgent
  const os = /Android/i.test(agent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1) ? 'iOS'
      : /Windows/i.test(agent) ? 'Windows'
        : /Mac OS X/i.test(agent) ? 'macOS'
          : /CrOS/i.test(agent) ? 'ChromeOS'
            : /Linux/i.test(agent) ? 'Linux' : ''
  const browser = /Edg\//.test(agent) ? 'Edge'
    : /OPR\//.test(agent) ? 'Opera'
      : /SamsungBrowser/.test(agent) ? 'Samsung Internet'
        : /Firefox|FxiOS/.test(agent) ? 'Firefox'
          : /Chrome|CriOS/.test(agent) ? 'Chrome'
            : /Safari/.test(agent) ? 'Safari' : ''
  return [browser, os].filter(Boolean).join(' on ')
}

export function loadDeviceName() {
  try {
    const saved = localStorage.getItem(nameStorage)
    if (saved) return saved
    const generated = `${pick(adjectives)} ${pick(animals)}`
    localStorage.setItem(nameStorage, generated)
    return generated
  } catch {
    return `${pick(adjectives)} ${pick(animals)}`
  }
}

export function saveDeviceName(name: string) {
  try {
    localStorage.setItem(nameStorage, name)
  } catch {
    // The name still applies for this visit.
  }
}
