import { afterEach, describe, expect, test } from "vitest"
import { FaradayCage } from "faraday-cage"
import * as E from "fp-ts/Either"
import { runTest, fakeResponse, defaultRequest } from "~/utils/test-helpers"
import { runTestScript } from "~/web"
import { _setCagePromiseForTesting, getCageResetCount } from "~/utils/cage"

/**
 * Verifies that the test runner properly recovers from script errors without
 * stale state persisting across subsequent executions.
 */
describe("script error recovery", () => {
  test("runtime error followed by valid script should not show stale error", async () => {
    const errorScript = `
a(); // ReferenceError: a is not defined
hopp.test("Should not run", () => {
  hopp.expect(hopp.response.statusCode).toBe(200);
});
`

    const errorResult = await runTest(errorScript, {
      global: [],
      selected: [],
    })()

    expect(errorResult).toBeLeft()

    const validScript = `
// a(); - commented out
hopp.test("Status code is 200", () => {
  hopp.expect(hopp.response.statusCode).toBe(200);
});
`

    const validResult = await runTest(validScript, {
      global: [],
      selected: [],
    })()

    expect(validResult).toEqualRight([
      expect.objectContaining({
        descriptor: "root",
        children: [
          expect.objectContaining({
            descriptor: "Status code is 200",
            expectResults: [
              expect.objectContaining({
                status: "pass",
                message: expect.stringContaining("Expected '200' to be '200'"),
              }),
            ],
          }),
        ],
      }),
    ])
  })

  test("multiple consecutive runtime errors should each be fresh", async () => {
    const error1 = await runTest(`a();`, { global: [], selected: [] })()
    expect(error1).toBeLeft()

    const error2 = await runTest(`b();`, { global: [], selected: [] })()
    expect(error2).toBeLeft()

    const valid = await runTest(
      `hopp.test("Works", () => { hopp.expect(true).toBe(true); });`,
      { global: [], selected: [] }
    )()

    expect(valid).toEqualRight([
      expect.objectContaining({
        descriptor: "root",
        children: [
          expect.objectContaining({
            descriptor: "Works",
            expectResults: [
              expect.objectContaining({
                status: "pass",
                message: expect.stringContaining(
                  "Expected 'true' to be 'true'"
                ),
              }),
            ],
          }),
        ],
      }),
    ])
  })

  test("syntax error followed by valid script should work", async () => {
    const syntaxError = await runTest(`const x = ;`, {
      global: [],
      selected: [],
    })()
    expect(syntaxError).toBeLeft()

    const valid = await runTest(
      `hopp.test("Works", () => { hopp.expect(true).toBe(true); });`,
      { global: [], selected: [] }
    )()

    expect(valid).toEqualRight([
      expect.objectContaining({
        descriptor: "root",
        children: [
          expect.objectContaining({
            descriptor: "Works",
            expectResults: [
              expect.objectContaining({
                status: "pass",
                message: expect.stringContaining(
                  "Expected 'true' to be 'true'"
                ),
              }),
            ],
          }),
        ],
      }),
    ])
  })
})

/**
 * Exercises the production singleton path where a corrupted cage persists
 * across calls. The retry-on-bootstrap-error logic should transparently
 * recover so the user never sees the stale failure.
 */
describe("singleton cage retry on bootstrap error", () => {
  afterEach(() => {
    _setCagePromiseForTesting(null)
  })

  test("bootstrap error triggers retry on fresh cage", async () => {
    const corruptedCage = await FaradayCage.create()
    const originalRunCode = corruptedCage.runCode.bind(corruptedCage)

    let callCount = 0
    corruptedCage.runCode = ((...args: Parameters<typeof originalRunCode>) => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          type: "error" as const,
          err: new Error("cannot convert to object"),
        })
      }
      return originalRunCode(...args)
    }) as typeof originalRunCode

    _setCagePromiseForTesting(Promise.resolve(corruptedCage))

    const resetsBefore = getCageResetCount()

    const result = await runTestScript(
      `hopp.test("Should work after retry", () => { hopp.expect(true).toBe(true); });`,
      {
        envs: { global: [], selected: [] },
        request: defaultRequest,
        response: fakeResponse,
        cookies: null,
        experimentalScriptingSandbox: true,
      }
    )

    expect(getCageResetCount()).toBeGreaterThan(resetsBefore)
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      expect(result.right.tests).toEqual(
        expect.objectContaining({
          descriptor: "root",
          children: [
            expect.objectContaining({
              descriptor: "Should work after retry",
              expectResults: [expect.objectContaining({ status: "pass" })],
            }),
          ],
        })
      )
    }
  })

  test("user script errors do not trigger retry", async () => {
    const cage = await FaradayCage.create()
    _setCagePromiseForTesting(Promise.resolve(cage))

    const resetsBefore = getCageResetCount()

    const result = await runTestScript(`a();`, {
      envs: { global: [], selected: [] },
      request: defaultRequest,
      response: fakeResponse,
      cookies: null,
      experimentalScriptingSandbox: true,
    })

    expect(E.isLeft(result)).toBe(true)
    expect(getCageResetCount()).toBe(resetsBefore)
  })
})
