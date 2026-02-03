/**
 * Browser Actions
 *
 * Execute browser actions like click, type, hover, etc.
 */

import { createBrowserClient, type BrowserClient } from "./browser-client.js";
import { getStoredRefs, parseRef } from "./snapshot.js";

export type ActRequest =
  | { kind: "click"; ref: string; doubleClick?: boolean; button?: string; modifiers?: string[] }
  | { kind: "type"; ref: string; text: string; submit?: boolean; slowly?: boolean }
  | { kind: "press"; key: string }
  | { kind: "hover"; ref: string }
  | { kind: "drag"; startRef: string; endRef: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "fill"; fields: Array<{ ref: string; value: string }> }
  | { kind: "scroll"; ref?: string; direction?: "up" | "down" | "left" | "right"; amount?: number }
  | { kind: "wait"; timeMs?: number; text?: string; textGone?: string; selector?: string }
  | { kind: "resize"; width: number; height: number };

export type ActResult = {
  ok: boolean;
  error?: string;
};

/**
 * Find element by ref using stored accessibility refs
 */
async function findElementByRef(
  client: BrowserClient,
  ref: string
): Promise<{ nodeId: number; x: number; y: number; width: number; height: number }> {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new Error(`Invalid ref: ${ref}`);
  }

  const refInfo = getStoredRefs()[parsed];
  if (!refInfo) {
    throw new Error(`Ref not found: ${parsed}. Run snapshot first to get element refs.`);
  }

  // Build selector from role and name (for debugging reference)
  const { role, name, nth } = refInfo;
  const _selector =
    name
      ? `[role="${role}"][aria-label="${name}"], [role="${role}"]:has-text("${name}")`
      : `[role="${role}"]`;
  void _selector; // Used for debugging

  // Use DOM to find element and get bounding box
  const expression = `(() => {
    const role = ${JSON.stringify(role)};
    const name = ${JSON.stringify(name)};
    const nth = ${JSON.stringify(nth ?? 0)};

    // Find all matching elements
    const allElements = document.querySelectorAll('[role="' + role + '"]');
    let matches = [];

    for (const el of allElements) {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
      if (!name || label.includes(name)) {
        matches.push(el);
      }
    }

    // Also try by tag name for common roles
    const tagMap = {
      button: 'button',
      link: 'a',
      textbox: 'input[type="text"], input[type="email"], input[type="password"], input:not([type]), textarea',
      checkbox: 'input[type="checkbox"]',
      radio: 'input[type="radio"]',
      combobox: 'select',
      searchbox: 'input[type="search"]',
    };

    if (tagMap[role] && matches.length === 0) {
      const tagElements = document.querySelectorAll(tagMap[role]);
      for (const el of tagElements) {
        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim() || '';
        if (!name || label.includes(name)) {
          matches.push(el);
        }
      }
    }

    if (matches.length === 0) {
      return { error: 'Element not found for role=' + role + (name ? ' name=' + name : '') };
    }

    const el = matches[nth] || matches[0];
    const rect = el.getBoundingClientRect();

    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag: el.tagName.toLowerCase(),
    };
  })()`;

  await client.send("Runtime.enable", {});
  const result = (await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: { error?: string; x?: number; y?: number; width?: number; height?: number } } };

  const value = result?.result?.value;
  if (!value || value.error) {
    throw new Error(value?.error ?? "Element not found");
  }

  return {
    nodeId: 0,
    x: value.x ?? 0,
    y: value.y ?? 0,
    width: value.width ?? 0,
    height: value.height ?? 0,
  };
}

/**
 * Click on element
 */
export async function click(
  ref: string,
  opts?: { doubleClick?: boolean; button?: string; modifiers?: string[] }
): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    const el = await findElementByRef(client, ref);

    const button = opts?.button ?? "left";
    const clickCount = opts?.doubleClick ? 2 : 1;

    // Mouse down
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: el.x,
      y: el.y,
      button,
      clickCount,
    });

    // Mouse up
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: el.x,
      y: el.y,
      button,
      clickCount,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Type text into element
 */
export async function type(
  ref: string,
  text: string,
  opts?: { submit?: boolean; slowly?: boolean }
): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    // First click to focus
    const el = await findElementByRef(client, ref);
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: el.x,
      y: el.y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: el.x,
      y: el.y,
      button: "left",
      clickCount: 1,
    });

    // Clear existing text
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", modifiers: 2 }); // Ctrl+A
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 2 });

    // Type text
    if (opts?.slowly) {
      for (const char of text) {
        await client.send("Input.insertText", { text: char });
        await new Promise((r) => setTimeout(r, 50));
      }
    } else {
      await client.send("Input.insertText", { text });
    }

    // Submit if requested
    if (opts?.submit) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Press a keyboard key
 */
export async function press(key: string): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    // Map common key names
    const keyMap: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: "Enter", keyCode: 13 },
      Tab: { code: "Tab", keyCode: 9 },
      Escape: { code: "Escape", keyCode: 27 },
      Backspace: { code: "Backspace", keyCode: 8 },
      Delete: { code: "Delete", keyCode: 46 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { code: "ArrowRight", keyCode: 39 },
      Space: { code: "Space", keyCode: 32 },
    };

    const keyInfo = keyMap[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };

    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    });

    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: keyInfo.code,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Hover over element
 */
export async function hover(ref: string): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    const el = await findElementByRef(client, ref);

    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: el.x,
      y: el.y,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Drag from one element to another
 */
export async function drag(startRef: string, endRef: string): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    const startEl = await findElementByRef(client, startRef);
    const endEl = await findElementByRef(client, endRef);

    // Mouse down on start
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startEl.x,
      y: startEl.y,
      button: "left",
    });

    // Move to end
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: endEl.x,
      y: endEl.y,
    });

    // Mouse up on end
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: endEl.x,
      y: endEl.y,
      button: "left",
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Select options in a dropdown
 */
export async function select(ref: string, values: string[]): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    // Click to open dropdown
    await click(ref);
    await new Promise((r) => setTimeout(r, 200));

    // Select each option by clicking
    for (const value of values) {
      const expression = `(() => {
        const options = document.querySelectorAll('option, [role="option"]');
        for (const opt of options) {
          if (opt.textContent?.includes(${JSON.stringify(value)}) || opt.value === ${JSON.stringify(value)}) {
            const rect = opt.getBoundingClientRect();
            return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
          }
        }
        return { error: 'Option not found: ${value}' };
      })()`;

      await client.send("Runtime.enable", {});
      const result = (await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result?: { value?: { x?: number; y?: number; error?: string } } };

      if (result?.result?.value?.error) {
        throw new Error(result.result.value.error);
      }

      const { x, y } = result?.result?.value ?? {};
      if (x !== undefined && y !== undefined) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
        });
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Fill multiple form fields
 */
export async function fill(fields: Array<{ ref: string; value: string }>): Promise<ActResult> {
  for (const field of fields) {
    const result = await type(field.ref, field.value);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

/**
 * Scroll the page or element
 */
export async function scroll(opts?: {
  ref?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    const direction = opts?.direction ?? "down";
    const amount = opts?.amount ?? 300;

    let x = 0,
      y = 0;
    if (opts?.ref) {
      const el = await findElementByRef(client, opts.ref);
      x = el.x;
      y = el.y;
    } else {
      // Scroll at center of viewport
      const result = (await client.send("Runtime.evaluate", {
        expression: "JSON.stringify({ x: window.innerWidth/2, y: window.innerHeight/2 })",
        returnByValue: true,
      })) as { result?: { value?: string } };
      const pos = JSON.parse(result?.result?.value ?? "{}");
      x = pos.x ?? 400;
      y = pos.y ?? 300;
    }

    let deltaX = 0,
      deltaY = 0;
    switch (direction) {
      case "up":
        deltaY = -amount;
        break;
      case "down":
        deltaY = amount;
        break;
      case "left":
        deltaX = -amount;
        break;
      case "right":
        deltaX = amount;
        break;
    }

    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Wait for condition
 */
export async function wait(opts: {
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
}): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    // Simple time wait
    if (opts.timeMs) {
      await new Promise((r) => setTimeout(r, opts.timeMs));
      return { ok: true };
    }

    // Wait for text to appear
    if (opts.text) {
      const maxWait = 10000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const result = (await client.send("Runtime.evaluate", {
          expression: `document.body.innerText.includes(${JSON.stringify(opts.text)})`,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        if (result?.result?.value) {
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { ok: false, error: `Text not found after ${maxWait}ms: ${opts.text}` };
    }

    // Wait for text to disappear
    if (opts.textGone) {
      const maxWait = 10000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const result = (await client.send("Runtime.evaluate", {
          expression: `!document.body.innerText.includes(${JSON.stringify(opts.textGone)})`,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        if (result?.result?.value) {
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { ok: false, error: `Text still present after ${maxWait}ms: ${opts.textGone}` };
    }

    // Wait for selector
    if (opts.selector) {
      const maxWait = 10000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const result = (await client.send("Runtime.evaluate", {
          expression: `!!document.querySelector(${JSON.stringify(opts.selector)})`,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        if (result?.result?.value) {
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { ok: false, error: `Selector not found after ${maxWait}ms: ${opts.selector}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Resize browser viewport
 */
export async function resize(width: number, height: number): Promise<ActResult> {
  const client = await createBrowserClient();
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Execute action from request object
 */
export async function executeAction(request: ActRequest): Promise<ActResult> {
  switch (request.kind) {
    case "click":
      return click(request.ref, {
        doubleClick: request.doubleClick,
        button: request.button,
        modifiers: request.modifiers,
      });
    case "type":
      return type(request.ref, request.text, {
        submit: request.submit,
        slowly: request.slowly,
      });
    case "press":
      return press(request.key);
    case "hover":
      return hover(request.ref);
    case "drag":
      return drag(request.startRef, request.endRef);
    case "select":
      return select(request.ref, request.values);
    case "fill":
      return fill(request.fields);
    case "scroll":
      return scroll({
        ref: request.ref,
        direction: request.direction,
        amount: request.amount,
      });
    case "wait":
      return wait({
        timeMs: request.timeMs,
        text: request.text,
        textGone: request.textGone,
        selector: request.selector,
      });
    case "resize":
      return resize(request.width, request.height);
    default:
      return { ok: false, error: `Unknown action kind: ${(request as ActRequest).kind}` };
  }
}
