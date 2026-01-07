// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react'

/**
 * Mermaid initialization Hook
 * Used to initialize Mermaid library and theme monitoring
 */
export function useMermaidInit(selectedContent: unknown) {
  useEffect(() => {
    // Set code block theme
    const setCodeTheme = () => {
      const isDarkTheme =
        document.documentElement.classList.contains('dark') ||
        window.matchMedia('(prefers-color-scheme: dark)').matches

      if (isDarkTheme) {
        document.documentElement.classList.remove('light')
      } else {
        document.documentElement.classList.add('light')
      }
    }

    // Initial setup
    setCodeTheme()

    // Monitor theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleThemeChange = (_e: MediaQueryListEvent) => {
      setCodeTheme()
    }

    mediaQuery.addEventListener('change', handleThemeChange)

    // Dynamically import Mermaid library
    const initMermaid = async () => {
      try {
        // Only execute in client environment
        if (typeof window !== 'undefined') {
          const mermaidModule = await import('mermaid')
          const mermaid = mermaidModule.default

          mermaid.initialize({
            startOnLoad: true,
            suppressErrorRendering: true,
            theme: 'base',
            themeVariables: {
              // General theme variables
              primaryColor: '#f8fafc',
              primaryTextColor: '#0f172a',
              primaryBorderColor: '#94a3b8',
              lineColor: '#64748b',
              secondaryColor: '#f1f5f9',
              tertiaryColor: '#e2e8f0',
              background: '#ffffff',
              mainBkg: '#f8fafc',
              secondBkg: '#f1f5f9',
              mainContrastColor: '#0f172a',
              darkTextColor: '#0f172a',
              textColor: '#0f172a',
              labelTextColor: '#0f172a',
              signalTextColor: '#0f172a',
              // Sequence diagram specific variables
              actorBkg: '#f8fafc',
              actorBorder: '#14b8a6',
              actorTextColor: '#0f172a',
              actorLineColor: '#cbd5e1',
              signalColor: '#64748b',
              labelBoxBkgColor: '#f1f5f9',
              labelBoxBorderColor: '#94a3b8',
              loopTextColor: '#1e293b',
              noteBkgColor: '#fef9c3',
              noteBorderColor: '#fbbf24',
              noteTextColor: '#1e293b',
              activationBkgColor: '#e0f2fe',
              activationBorderColor: '#0ea5e9',
              // Sequence diagram number settings
              sequenceNumberColor: '#ffffff',
            },
            securityLevel: 'loose',
            flowchart: {
              useMaxWidth: true,
              htmlLabels: true,
              curve: 'basis',
              padding: 15,
            },
            sequence: {
              diagramMarginX: 50,
              diagramMarginY: 20,
              actorMargin: 80,
              width: 180,
              height: 65,
              boxMargin: 10,
              boxTextMargin: 5,
              noteMargin: 15,
              messageMargin: 45,
              mirrorActors: true,
              bottomMarginAdj: 1,
              useMaxWidth: true,
              rightAngles: false,
              showSequenceNumbers: false,
              actorFontSize: 14,
              actorFontWeight: 600,
              noteFontSize: 13,
              noteFontWeight: 400,
              messageFontSize: 13,
              messageFontWeight: 500,
            },
            fontSize: 15,
            fontFamily:
              'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
            themeCSS: `
            /* ===== Flowchart Styles ===== */
            .node rect, .node circle, .node ellipse, .node polygon, .node path {
              fill: #f8fafc !important;
              stroke: #94a3b8 !important;
              stroke-width: 1px !important;
              rx: 8px;
              ry: 8px;
              filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.05));
            }
            .edgePath .path {
              stroke: #64748b !important;
              stroke-width: 1.5px !important;
            }
            .arrowheadPath {
              fill: #64748b !important;
            }
            .edgeLabel {
              background-color: rgba(248, 250, 252, 0.95) !important;
              color: #1e293b !important;
              font-weight: 500;
              font-size: 12px;
              padding: 3px 8px;
              border-radius: 4px;
              border: 1px solid rgba(148, 163, 184, 0.3);
            }
            .cluster rect {
              fill: #f1f5f9 !important;
              stroke: #94a3b8 !important;
              stroke-width: 1px !important;
              rx: 8px;
              ry: 8px;
            }
            .cluster text {
              fill: #1e293b !important;
              font-weight: 600;
              font-size: 13px;
            }
            text {
              fill: #1e293b !important;
              font-weight: 500 !important;
              font-size: 13px !important;
            }
            .nodeLabel {
              color: #1e293b !important;
              fill: #1e293b !important;
              font-weight: 500 !important;
              font-size: 13px !important;
            }
            .label text {
              fill: #1e293b !important;
            }
            .flowchart-link {
              stroke: #64748b !important;
              fill: none;
            }

            /* ===== Sequence Diagram Styles (Enhanced) ===== */
            /* Actor boxes - main participants */
            .actor {
              fill: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%) !important;
              stroke: #14b8a6 !important;
              stroke-width: 2px !important;
              rx: 8px !important;
              ry: 8px !important;
              filter: drop-shadow(0 2px 4px rgba(20, 184, 166, 0.15));
            }
            .actor-man {
              stroke: #14b8a6 !important;
              stroke-width: 2px !important;
            }
            .actor-man circle, .actor-man line {
              stroke: #14b8a6 !important;
              fill: #f8fafc !important;
            }

            /* Actor text labels */
            text.actor {
              fill: #0f172a !important;
              font-weight: 600 !important;
              font-size: 14px !important;
              font-family: system-ui, -apple-system, sans-serif !important;
            }

            /* Actor lifeline */
            .actor-line {
              stroke: #e2e8f0 !important;
              stroke-width: 1.5px !important;
              stroke-dasharray: 5, 3 !important;
            }

            /* Message lines */
            .messageLine0 {
              stroke: #64748b !important;
              stroke-width: 1.5px !important;
              marker-end: url(#arrowhead) !important;
            }
            .messageLine1 {
              stroke: #64748b !important;
              stroke-width: 1.5px !important;
              stroke-dasharray: 4, 3 !important;
            }

            /* Arrow markers */
            #arrowhead path {
              fill: #64748b !important;
              stroke: #64748b !important;
            }
            #crosshead path {
              fill: #64748b !important;
              stroke: #64748b !important;
            }
            #sequencenumber {
              fill: #ffffff !important;
            }

            /* Message text labels */
            .messageText {
              fill: #1e293b !important;
              font-size: 13px !important;
              font-weight: 500 !important;
              font-family: system-ui, -apple-system, sans-serif !important;
            }

            /* Note boxes - callouts */
            .note {
              fill: #fef9c3 !important;
              stroke: #fbbf24 !important;
              stroke-width: 1.5px !important;
              rx: 6px !important;
              ry: 6px !important;
              filter: drop-shadow(0 2px 4px rgba(251, 191, 36, 0.2));
            }
            .noteText, .noteText tspan {
              fill: #78350f !important;
              font-size: 12px !important;
              font-weight: 500 !important;
              font-family: system-ui, -apple-system, sans-serif !important;
            }

            /* Activation bars - when participant is active */
            .activation0, .activation1, .activation2 {
              fill: #e0f2fe !important;
              stroke: #0ea5e9 !important;
              stroke-width: 1.5px !important;
              rx: 3px !important;
              ry: 3px !important;
            }

            /* Loop/Alt/Opt boxes */
            .loopLine {
              stroke: #94a3b8 !important;
              stroke-width: 1.5px !important;
              stroke-dasharray: none !important;
              fill: transparent !important;
            }
            .loopText, .loopText tspan {
              fill: #475569 !important;
              font-size: 12px !important;
              font-weight: 600 !important;
              text-transform: uppercase !important;
              letter-spacing: 0.5px !important;
            }
            .labelBox {
              fill: #f1f5f9 !important;
              stroke: #94a3b8 !important;
              stroke-width: 1px !important;
              rx: 4px !important;
              ry: 4px !important;
            }
            .labelText, .labelText tspan {
              fill: #334155 !important;
              font-size: 12px !important;
              font-weight: 500 !important;
            }

            /* Section backgrounds for alt/else */
            rect.rect {
              fill: rgba(241, 245, 249, 0.5) !important;
              stroke: #94a3b8 !important;
              stroke-width: 1px !important;
            }

            /* Sequence number circles */
            .sequenceNumber {
              fill: #14b8a6 !important;
            }
            text.sequenceNumber {
              fill: #ffffff !important;
              font-weight: 700 !important;
            }

            /* ===== Other Diagram Types ===== */
            /* Class diagrams */
            .classGroup rect {
              fill: #f8fafc !important;
              stroke: #94a3b8 !important;
            }
            .classGroup .title {
              fill: #0f172a !important;
              font-weight: 600 !important;
            }
            .classGroup line {
              stroke: #e2e8f0 !important;
            }
            .relation {
              stroke: #64748b !important;
            }
            .dashed-line {
              stroke: #94a3b8 !important;
              stroke-dasharray: 5, 3 !important;
            }

            /* State diagrams */
            .statediagram-state rect {
              fill: #f8fafc !important;
              stroke: #94a3b8 !important;
              rx: 8px !important;
              ry: 8px !important;
            }
            .statediagram-state .divider {
              stroke: #e2e8f0 !important;
            }
            .statediagram-note rect {
              fill: #fef9c3 !important;
              stroke: #fbbf24 !important;
            }

            /* ER diagrams */
            .er.entityBox {
              fill: #f8fafc !important;
              stroke: #94a3b8 !important;
            }
            .er.attributeBoxOdd, .er.attributeBoxEven {
              fill: #f1f5f9 !important;
              stroke: #e2e8f0 !important;
            }
            .er.relationshipLine {
              stroke: #64748b !important;
            }

            /* Pie charts */
            .pieTitleText {
              fill: #0f172a !important;
              font-weight: 600 !important;
            }
            .slice {
              stroke: #ffffff !important;
              stroke-width: 2px !important;
            }
            .legend text {
              fill: #1e293b !important;
            }
          `,
          })

          // Manually render all mermaid diagrams on the page
          setTimeout(() => {
            mermaid.init(undefined, document.querySelectorAll('.mermaid'))
          }, 200)
        }
      } catch (error) {
        console.error('Failed to initialize mermaid:', error)
      }
    }

    if (selectedContent) {
      initMermaid()
    }

    // Cleanup function
    return () => {
      mediaQuery.removeEventListener('change', handleThemeChange)
    }
  }, [selectedContent])
}
