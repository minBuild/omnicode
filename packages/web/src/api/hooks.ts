/** 최소한의 비동기 훅. react-query 없이 로딩·오류·재조회만 제공한다. */
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface ResourceState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** 다시 불러온다. 이전 데이터는 유지한 채 loading만 켠다. */
  refetch: () => Promise<void>;
  /** 낙관적 갱신·다른 응답으로 교체할 때 */
  setData: (updater: T | ((prev: T | undefined) => T | undefined)) => void;
}

/** 의존성이 바뀔 때마다 fetcher를 호출한다. 언마운트·재호출 시 이전 요청은 abort된다. */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: DependencyList): ResourceState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    fetcherRef
      .current(controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setDataState(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e);
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const refetch = useCallback(async () => {
    setTick((t) => t + 1);
  }, []);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T | undefined)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | undefined) => T | undefined)(prev) : updater));
  }, []);

  return { data, error, loading, refetch, setData };
}

export interface AsyncAction<Args extends unknown[], R> {
  run: (...args: Args) => Promise<R | undefined>;
  pending: boolean;
  error: unknown;
  result: R | undefined;
  reset: () => void;
}

/** 버튼 클릭 같은 단발 작업. 실패해도 throw하지 않고 error에 담는다 (화면이 표시). */
export function useAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>): AsyncAction<Args, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [result, setResult] = useState<R | undefined>(undefined);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: Args) => {
    setPending(true);
    setError(undefined);
    try {
      const r = await fnRef.current(...args);
      if (mounted.current) setResult(r);
      return r;
    } catch (e: unknown) {
      if (mounted.current) setError(e);
      return undefined;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(undefined);
    setResult(undefined);
  }, []);

  return { run, pending, error, result, reset };
}
