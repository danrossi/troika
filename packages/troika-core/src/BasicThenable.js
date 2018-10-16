/**
 * Super lightweight thenable implementation, for handling async with Promise-like
 * ergonomics without relying on a complete Promise implementation or polyfill, and
 * entirely self-contained within a single function with no external dependencies
 * so it can be easily shipped across to a WorkerModule.
 *
 * This implementation conforms fully to the Promises/A+ spec so it can safely interoperate
 * with other thenable/Promise implementations. https://github.com/promises-aplus/promises-spec
 */
export default function BasicThenable() {
  let state = 0 // 0=pending, 1=fulfilled, -1=rejected
  let queue = []
  let value
  let scheduled = 0
  let completeCalled = 0

  function then(onResolve, onReject) {
    const nextThenable = BasicThenable()

    function handleNext() {
      const cb = state > 0 ? onResolve : onReject
      if (isFn(cb)) {
        try {
          const result = cb(value)
          if (result === nextThenable) {
            recursiveError()
          }
          const resultThen = getThenableThen(result)
          if (resultThen) {
            resultThen.call(result, nextThenable.resolve, nextThenable.reject)
          } else {
            nextThenable.resolve(result)
          }
        } catch (err) {
          nextThenable.reject(err)
        }
      } else {
        nextThenable[state > 0 ? 'resolve' : 'reject'](value)
      }
    }

    queue.push(handleNext)
    if (state) {
      scheduleQueueFlush()
    }
    return nextThenable
  }

  const resolve = oneTime(val => {
    if (!completeCalled) {
      complete(1, val)
    }
  })

  const reject = oneTime(reason => {
    if (!completeCalled) {
      complete(-1, reason)
    }
  })

  function complete(st, val) {
    completeCalled++
    let ignoreThrow = 0
    try {
      if (val === thenableObj) {
        recursiveError()
      }
      const valThen = st > 0 && getThenableThen(val)
      if (valThen) {
        valThen.call(val, oneTime(v => {
          ignoreThrow++
          complete(1, v)
        }), oneTime(v => {
          ignoreThrow++
          complete(-1, v)
        }))
      } else {
        state = st
        value = val
        scheduleQueueFlush()
      }
    } catch(e) {
      if (!state && !ignoreThrow) {
        complete(-1, e)
      }
    }
  }

  function scheduleQueueFlush() {
    if (!scheduled) {
      //setTimeout(flushQueue, 0)
      process.nextTick(flushQueue)
      scheduled = 1
    }
  }

  function flushQueue() {
    const q = queue
    scheduled = 0
    queue = []
    q.forEach(fn => fn())
  }

  function getThenableThen(val) {
    const valThen = val && (isFn(val) || typeof val === 'object') && val.then
    return isFn(valThen) && valThen
  }

  function oneTime(fn) {
    let called = 0
    return function(...args) {
      if (!called++) {
        fn.apply(this, args)
      }
    }
  }

  function recursiveError() {throw new TypeError('t.resolve(t)')}

  const isFn = v => typeof v === 'function'

  const thenableObj = {
    then,
    resolve,
    reject
  }
  return thenableObj
}