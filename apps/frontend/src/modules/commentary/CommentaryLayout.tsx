import { useEffect } from 'react';
import { Steps, Button, Space, Typography } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectCurrentStep,
  selectMaxAllowedStep,
  selectFlowMode,
  setCurrentStep,
  setFlowMode,
} from '../../store/commentarySlice.js';
import { selectModelConfigLoaded, setModelConfig } from '../../store/modelConfigSlice.js';
import { useRouter, stepToRoute, routeToStep } from '../router/Router.js';
import { useTheme } from '../../hooks/useTheme.js';
import { Step1Page } from './Step1Page.js';
import { Step2Page } from './Step2Page.js';
import { Step3Page } from './Step3Page.js';
import { Step4Page } from './Step4Page.js';
import { Step5Page } from './Step5Page.js';
import { Step6Page } from './Step6Page.js';
import { Step7Page } from './Step7Page.js';

const STEP_TITLES = [
  '上传与脚本',
  '裁剪片段',
  '生成配音',
  '合并字幕',
  '拼接成片',
  '封面文字',
  '嵌入广告',
];

function ThemeSwitcherMini(): JSX.Element {
  const { mode, setMode } = useTheme();
  return (
    <Space size={4}>
      {(
        [
          ['light', '浅色'],
          ['dark', '深色'],
          ['system', '系统'],
        ] as const
      ).map(([key, label]) => (
        <Button
          key={key}
          size="small"
          type={mode === key ? 'primary' : 'default'}
          onClick={() => setMode(key)}
        >
          {label}
        </Button>
      ))}
    </Space>
  );
}

export function CommentaryLayout(): JSX.Element {
  const dispatch = useDispatch();
  const currentStep = useSelector(selectCurrentStep);
  const maxAllowed = useSelector(selectMaxAllowedStep);
  const flowMode = useSelector(selectFlowMode);
  const modelConfigLoaded = useSelector(selectModelConfigLoaded);
  const { replace, route } = useRouter();

  // 进入解说模式时加载模型配置（设置页/Agent 页可能尚未加载）
  useEffect(() => {
    if (modelConfigLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await window.viewPoint.getModelConfig();
        if (!cancelled && config?.platforms) dispatch(setModelConfig(config));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelConfigLoaded, dispatch]);

  // 路由 → 状态同步
  useEffect(() => {
    const fromRoute = routeToStep(route.name);
    if (fromRoute && fromRoute !== currentStep) {
      dispatch(setCurrentStep(fromRoute));
    }
  }, [route.name, currentStep, dispatch]);

  // 越步门禁
  useEffect(() => {
    if (currentStep > maxAllowed) {
      dispatch(setCurrentStep(maxAllowed));
      replace(stepToRoute(maxAllowed));
    }
  }, [currentStep, maxAllowed, dispatch, replace]);

  const goStep = (step: number) => {
    if (step > maxAllowed) return;
    dispatch(setCurrentStep(step));
    replace(stepToRoute(step));
  };

  const renderStep = () => {
    switch (currentStep) {
      case 2:
        return <Step2Page />;
      case 3:
        return <Step3Page />;
      case 4:
        return <Step4Page />;
      case 5:
        return <Step5Page />;
      case 6:
        return <Step6Page />;
      case 7:
        return <Step7Page />;
      case 1:
      default:
        return <Step1Page />;
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-surface)',
        }}
      >
        <Space>
          <Typography.Title level={5} style={{ margin: 0, color: 'inherit' }}>
            Frame Sight · 影视解说
          </Typography.Title>
          <Button
            size="small"
            onClick={() => {
              dispatch(setFlowMode('agent'));
              replace('home');
            }}
          >
            返回首页
          </Button>
        </Space>
        <Space>
          <ThemeSwitcherMini />
          <Typography.Text type="secondary">模式：{flowMode === 'normal' ? '解说' : 'Agent'}</Typography.Text>
        </Space>
      </div>
      <div style={{ padding: '12px 20px 0' }}>
        <Steps
          size="small"
          current={currentStep - 1}
          onChange={(i) => goStep(i + 1)}
          items={STEP_TITLES.map((t, i) => ({
            title: t,
            disabled: i + 1 > maxAllowed,
          }))}
        />
      </div>
      <div style={{ padding: 16 }}>{renderStep()}</div>
    </div>
  );
}
