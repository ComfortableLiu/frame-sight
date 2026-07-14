import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export type RouteName = 'agent' | 'settings';

export interface RouteEntry {
  name: RouteName;
  /** 额外数据，如从哪里来的 */
  from?: RouteName;
}

interface RouterCtx {
  /** 当前路由 */
  route: RouteEntry;
  /** push 新路由（入栈） */
  push: (name: RouteName) => void;
  /** 返回上一个路由（出栈），无栈则回 agent */
  back: () => void;
  /** 是否可以返回 */
  canBack: boolean;
}

const RouterContext = createContext<RouterCtx | null>(null);

export function RouterProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [route, setRoute] = useState<RouteEntry>({ name: 'agent' });
  const stackRef = useRef<RouteEntry[]>([]);

  const push = useCallback((name: RouteName) => {
    stackRef.current.push(route);
    setRoute({ name, from: route.name });
  }, [route]);

  const back = useCallback(() => {
    const prev = stackRef.current.pop();
    setRoute(prev ?? { name: 'agent' });
  }, []);

  const canBack = stackRef.current.length > 0;

  const value = useMemo<RouterCtx>(
    () => ({ route, push, back, canBack }),
    [route, push, back, canBack],
  );

  return (
    <RouterContext.Provider value={value}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterCtx {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be inside RouterProvider');
  return ctx;
}
