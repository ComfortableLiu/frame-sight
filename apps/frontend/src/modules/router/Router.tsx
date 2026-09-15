import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export type RouteName =
  | 'agent'
  | 'settings'
  | 'commentary-step-1'
  | 'commentary-step-2'
  | 'commentary-step-3'
  | 'commentary-step-4'
  | 'commentary-step-5'
  | 'commentary-step-6'
  | 'commentary-step-7';

export interface RouteEntry {
  name: RouteName;
  from?: RouteName;
}

interface RouterCtx {
  route: RouteEntry;
  push: (name: RouteName) => void;
  replace: (name: RouteName) => void;
  back: () => void;
  canBack: boolean;
}

const RouterContext = createContext<RouterCtx | null>(null);

const DEFAULT_ROUTE: RouteName = 'agent';

export function routeToStep(name: RouteName): number | null {
  const m = name.match(/^commentary-step-(\d)$/);
  return m ? parseInt(m[1], 10) : null;
}

export function stepToRoute(step: number): RouteName {
  return `commentary-step-${Math.min(7, Math.max(1, step))}` as RouteName;
}

export function RouterProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [route, setRoute] = useState<RouteEntry>({ name: DEFAULT_ROUTE });
  const stackRef = useRef<RouteEntry[]>([]);

  const push = useCallback((name: RouteName) => {
    stackRef.current.push(route);
    setRoute({ name, from: route.name });
  }, [route]);

  const replace = useCallback((name: RouteName) => {
    setRoute({ name, from: route.name });
  }, [route]);

  const back = useCallback(() => {
    const prev = stackRef.current.pop();
    setRoute(prev ?? { name: DEFAULT_ROUTE });
  }, []);

  const canBack = stackRef.current.length > 0;

  const value = useMemo<RouterCtx>(
    () => ({ route, push, replace, back, canBack }),
    [route, push, replace, back, canBack],
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
