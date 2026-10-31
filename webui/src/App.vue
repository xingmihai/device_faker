<template>
  <div :class="['app-container', { dark: isDark }]">
    <main class="main-content">
      <div
        ref="pageStageRef"
        :class="['page-stage', { 'page-stage--dragging': swipe.isSwipeDragging.value }]"
        @click.capture="swipe.handleClickCapture"
        @pointercancel="swipe.handlePointerCancel"
        @pointerdown="swipe.handlePointerDown"
        @pointermove="swipe.handlePointerMove"
        @pointerup="swipe.handlePointerEnd"
      >
        <div class="page-track">
          <section
            v-for="page in nav.pages.value"
            :key="page.id"
            :aria-hidden="nav.activePage.value !== page.id"
            class="page-panel"
          >
            <div
              class="page-scroll"
              @touchstart="overscroll.handleTouchStart"
              @touchmove="overscroll.handleTouchMove"
              @touchend="overscroll.handleTouchEnd"
              @touchcancel="overscroll.handleTouchEnd"
            >
              <div class="page-scroll-content">
                <header class="app-header">
                  <span class="app-header__glow" aria-hidden="true"></span>
                  <h1 class="header-title">
                    Device Faker
                    <span class="version">{{ nav.versionDisplay.value }}</span>
                  </h1>
                </header>
                <component
                  :is="page.component"
                  v-if="nav.shouldRenderPage(page.id)"
                  class="page-view"
                />
                <AsyncPagePlaceholder v-else />
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <nav class="bottom-nav glass-effect">
      <button
        v-for="page in nav.pages.value"
        :key="page.id"
        :class="['nav-item', { active: nav.activePage.value === page.id }]"
        @pointerdown="primePage(page.id)"
        @click.stop="nav.handlePageChange(page.id)"
      >
        <span class="nav-icon">
          <component :is="page.icon" :size="23" />
        </span>
        <span class="nav-label">{{ page.label }}</span>
        <span class="nav-indicator" aria-hidden="true"></span>
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { useSettingsStore } from './stores/settings'
import { applyThemeToDocument } from './utils/theme'
import { usePageNavigation, PAGE_INDEX_BY_ID } from './composables/usePageNavigation'
import { usePageSwipe } from './composables/usePageSwipe'
import { useOverscrollBounce } from './composables/useOverscrollBounce'
import { usePageHistory } from './composables/usePageHistory'
import type { PageId } from './stores/navigation'

type ResizeObserverInstance = InstanceType<typeof window.ResizeObserver>

const AsyncPagePlaceholder = defineComponent({
  name: 'AsyncPagePlaceholder',
  setup() {
    return () =>
      h('div', { class: 'page-placeholder glass-effect' }, [
        h('div', { class: 'page-placeholder__line page-placeholder__line--title' }),
        h('div', { class: 'page-placeholder__line' }),
        h('div', { class: 'page-placeholder__line page-placeholder__line--short' }),
      ])
  },
})

let pageStageResizeObserver: ResizeObserverInstance | null = null
let mediaQuery: ReturnType<typeof window.matchMedia> | null = null
let mediaQueryListener: ((event: { matches: boolean }) => void) | null = null

const pageStageRef = ref<HTMLElement | null>(null)
const settingsStore = useSettingsStore()
const systemPrefersDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)

const isDark = computed(() => {
  if (settingsStore.theme === 'system') return systemPrefersDark.value
  return settingsStore.theme === 'dark'
})

// Composables — break circular dependency
const history = usePageHistory()
const nav = usePageNavigation({
  isHandlingPopstate: history.isHandlingPopstate,
  animateToPage: (pageId) => swipe.settleTo(PAGE_INDEX_BY_ID[pageId]),
})
history.bindSetActivePage(nav.setActivePage)

const swipe = usePageSwipe({
  activePage: nav.activePage,
  pageStageWidth: nav.pageStageWidth,
  pageStageRef,
  primeNeighborPages: nav.primeNeighborPages,
  setActivePageSilent: nav.setActivePageSilent,
})

const overscroll = useOverscrollBounce()

function primePage(pageId: PageId) {
  if (pageId === 'home') return
  nav.primeNeighborPages(PAGE_INDEX_BY_ID[pageId])
}

// Theme
watch(isDark, (v) => applyThemeToDocument(v), { immediate: true })

// Lifecycle
function syncWidth() {
  nav.syncPageStageWidth(pageStageRef.value)
  swipe.snapToCurrentPage()
}

onMounted(() => {
  history.setupHistory()
  nav.scheduleConfigBootstrap()
  nav.schedulePageWarmup()
  nav.scheduleAppDataWarmup()
  syncWidth()

  window.addEventListener('resize', syncWidth, { passive: true })

  if (typeof window.ResizeObserver === 'function' && pageStageRef.value) {
    pageStageResizeObserver = new window.ResizeObserver(syncWidth)
    pageStageResizeObserver.observe(pageStageRef.value)
  }

  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  systemPrefersDark.value = mediaQuery.matches
  mediaQueryListener = (event) => {
    systemPrefersDark.value = event.matches
  }
  mediaQuery.addEventListener('change', mediaQueryListener)
})

onUnmounted(() => {
  history.cleanup()
  swipe.cleanup()
  overscroll.cleanup()
  nav.cleanup()

  window.removeEventListener('resize', syncWidth)
  pageStageResizeObserver?.disconnect()
  pageStageResizeObserver = null

  if (mediaQuery && mediaQueryListener) {
    mediaQuery.removeEventListener('change', mediaQueryListener)
  }
})
</script>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  background: var(--background);
  padding: 0 var(--safe-area-inset-right) var(--safe-area-inset-bottom) var(--safe-area-inset-left);
}

.app-header {
  padding-top: calc(var(--safe-area-inset-top) + 1.125rem);
  padding-left: 1.25rem;
  padding-right: 1.25rem;
  padding-bottom: 1.125rem;
  border-radius: 0 0 var(--radius-xl) var(--radius-xl);
  margin-bottom: 0.75rem;
  box-shadow: var(--shadow-sm);
  position: relative;
  overflow: hidden;
  background: var(--card-bg);
  border-bottom: 1px solid var(--border);
}

/* 柔和渐变铺底 */
.app-header::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
  opacity: 0.07;
  z-index: 0;
}

/* 右上角一枚柔光斑：让标题区不至于太"平" */
.app-header__glow {
  position: absolute;
  top: -60%;
  right: -12%;
  width: 15rem;
  height: 15rem;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    rgba(168, 85, 247, 0.22) 0%,
    rgba(14, 165, 233, 0.1) 45%,
    transparent 70%
  );
  filter: blur(6px);
  z-index: 0;
  pointer-events: none;
}

.dark .app-header__glow {
  background: radial-gradient(
    circle,
    rgba(168, 85, 247, 0.28) 0%,
    rgba(14, 165, 233, 0.14) 45%,
    transparent 70%
  );
}

.header-title {
  font-size: 1.625rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  line-height: 1;
  position: relative;
  z-index: 1;
}

/* 版本号做成精致胶囊，不再是一个"灰字" */
.version {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--text-secondary);
  line-height: 1;
  padding: 0.25rem 0.5rem;
  margin-bottom: 0.15rem;
  border-radius: var(--radius-pill);
  background: var(--gradient-wash);
  box-shadow: inset 0 0 0 1px rgba(14, 165, 233, 0.14);
  -webkit-text-fill-color: var(--text-secondary);
}

.dark .version {
  box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.2);
}

.main-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  display: flex;
}

.page-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  touch-action: pan-y;
}

.page-stage--dragging {
  user-select: none;
  -webkit-user-select: none;
  cursor: grabbing;
}

.page-track {
  display: flex;
  height: 100%;
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

.page-panel {
  flex: 0 0 100%;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 0 0.875rem;
}

.page-scroll {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 5.5rem;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: none;
  overflow-anchor: none;
  touch-action: pan-y;
}

.page-scroll-content {
  min-height: 100%;
}

.page-view {
  min-height: 100%;
  width: 100%;
}

.page-placeholder {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.75rem 1.5rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  min-height: 14rem;
}

.page-placeholder__line {
  height: 0.95rem;
  width: 100%;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--border) 25%, var(--card-bg) 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: page-placeholder-shimmer 1.4s ease-in-out infinite;
  opacity: 0.7;
}

.page-placeholder__line--title {
  width: 42%;
  height: 1.25rem;
  margin-bottom: 0.25rem;
}

.page-placeholder__line--short {
  width: 65%;
}

@keyframes page-placeholder-shimmer {
  from {
    background-position: -200% 0;
  }

  to {
    background-position: 200% 0;
  }
}

.bottom-nav {
  display: flex;
  justify-content: space-around;
  align-items: center;
  padding: 0.5rem 0.5rem calc(0.375rem + var(--safe-area-inset-bottom));
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow:
    0 -6px 24px -8px rgba(15, 23, 42, 0.14),
    0 -1px 3px rgba(15, 23, 42, 0.05);
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  pointer-events: auto;
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(24px) saturate(180%);
  border-top: 1px solid rgba(255, 255, 255, 0.5);
}

.dark .bottom-nav {
  background: rgba(30, 41, 59, 0.86);
  backdrop-filter: blur(24px) saturate(160%);
  border-top: 1px solid rgba(51, 65, 85, 0.5);
  box-shadow:
    0 -6px 28px -8px rgba(0, 0, 0, 0.5),
    0 -1px 3px rgba(0, 0, 0, 0.3);
}

.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4375rem 1rem 0.5rem;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  transition:
    color 0.22s var(--ease-standard),
    transform 0.22s var(--ease-standard);
  border-radius: var(--radius-md);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
  touch-action: manipulation;
  flex: 1 1 0;
}

.nav-item:active {
  transform: scale(0.94);
}

/* 图标容器：激活时轻微上浮 + 缩放 */
.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.28s var(--ease-spring);
}

.nav-item.active {
  color: var(--primary);
}

.nav-item.active .nav-icon {
  transform: translateY(-1px) scale(1.06);
}

.nav-item.active .nav-icon svg {
  filter: drop-shadow(0 2px 8px rgba(14, 165, 233, 0.45));
}

.nav-label {
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  transition: font-weight 0.22s var(--ease-standard);
}

.nav-item.active .nav-label {
  font-weight: 650;
}

/* 激活指示条：底部渐变胶囊，滑入式出现 */
.nav-indicator {
  position: absolute;
  bottom: 0.125rem;
  left: 50%;
  width: 1.25rem;
  height: 3px;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
  transform: translate(-50%, 0.25rem) scaleX(0);
  opacity: 0;
  transition:
    transform 0.28s var(--ease-spring),
    opacity 0.22s var(--ease-standard);
  pointer-events: none;
}

.nav-item.active .nav-indicator {
  transform: translate(-50%, 0) scaleX(1);
  opacity: 1;
}
</style>
