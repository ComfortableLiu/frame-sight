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
import { useRouter, stepToRoute, routeToStep } from '../router/Router.js';
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

export function CommentaryLayout(): JSX.Element {
  const dispatch = useDispatch();
  const currentStep = useSelector(selectCurrentStep);
  const maxAllowed = useSelector(selectMaxAllowedStep);
  const flowMode = useSelector(selectFlowMode);
  const { replace, route } = useRouter();

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
    <div style={{ minHeight: '100vh', background: 'var(--bg-base, #0f1117)', color: 'var(--text-primary, #e4e6f0)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid var(--border, #2a2d42)',
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
              replace('agent');
            }}
          >
            切换到 Agent 模式
          </Button>
        </Space>
        <Typography.Text type="secondary">模式：{flowMode === 'normal' ? '解说' : 'Agent'}</Typography.Text>
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
