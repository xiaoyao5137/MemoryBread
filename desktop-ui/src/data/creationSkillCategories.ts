import type { CreationSkillCategory } from '../utils/creationSkills'

const categoryId = (suffix: string) => `01900000-0000-7000-8000-${suffix.padStart(12, '0')}`

type CategoryRow = [
  suffix: string,
  key: string,
  name: string,
  level: 1 | 2 | 3 | 4,
  parentSuffix: string | null,
  sortOrder: number,
]

interface RoleSpec {
  key: string
  name: string
  documents: ReadonlyArray<readonly [key: string, name: string]>
}

// 0024 中已经发布的稳定类目。ID、key 与父子关系不可改动。
const baseRows: CategoryRow[] = [
  ['1', 'internet', '互联网', 1, null, 10],
  ['2', 'finance', '金融', 1, null, 20],
  ['3', 'manufacturing', '制造', 1, null, 30],
  ['4', 'professional-services', '专业服务', 1, null, 40],

  ['101', 'internet-ecommerce', '电商零售', 2, '1', 10],
  ['102', 'internet-enterprise-service', '企业服务', 2, '1', 20],
  ['201', 'finance-banking-payment', '银行与支付', 2, '2', 10],
  ['202', 'finance-insurance', '保险', 2, '2', 20],
  ['301', 'manufacturing-smart', '智能制造', 2, '3', 10],
  ['302', 'manufacturing-consumer', '消费品制造', 2, '3', 20],
  ['401', 'professional-consulting', '咨询与研究', 2, '4', 10],
  ['402', 'professional-brand-media', '品牌与内容', 2, '4', 20],

  ['1101', 'ecommerce-product-manager', '产品经理', 3, '101', 10],
  ['1102', 'ecommerce-designer', 'UI/UX 设计师', 3, '101', 20],
  ['1103', 'ecommerce-software-engineer', '软件工程师', 3, '101', 30],
  ['1104', 'ecommerce-architect', '架构师', 3, '101', 40],
  ['1105', 'ecommerce-operator', '运营', 3, '101', 50],
  ['1201', 'enterprise-product-manager', '产品经理', 3, '102', 10],
  ['1202', 'enterprise-software-engineer', '软件工程师', 3, '102', 20],
  ['1203', 'enterprise-architect', '架构师', 3, '102', 30],
  ['1204', 'enterprise-customer-success', '客户成功顾问', 3, '102', 40],
  ['2101', 'bank-risk-manager', '风控经理', 3, '201', 10],
  ['2102', 'bank-data-analyst', '数据分析师', 3, '201', 20],
  ['2103', 'bank-product-manager', '产品经理', 3, '201', 30],
  ['2104', 'bank-architect', '架构师', 3, '201', 40],
  ['2201', 'insurance-product-manager', '产品经理', 3, '202', 10],
  ['2202', 'insurance-actuary-risk', '精算与风险', 3, '202', 20],
  ['2203', 'insurance-claims-operator', '理赔运营', 3, '202', 30],
  ['3101', 'smart-process-engineer', '工艺工程师', 3, '301', 10],
  ['3102', 'smart-software-engineer', '软件工程师', 3, '301', 20],
  ['3103', 'smart-architect', '架构师', 3, '301', 30],
  ['3201', 'consumer-industrial-designer', '工业设计师', 3, '302', 10],
  ['3202', 'consumer-quality-engineer', '质量工程师', 3, '302', 20],
  ['4101', 'consulting-consultant', '咨询顾问', 3, '401', 10],
  ['4102', 'consulting-research-analyst', '研究分析师', 3, '401', 20],
  ['4103', 'consulting-project-manager', '项目经理', 3, '401', 30],
  ['4201', 'brand-planner', '品牌策划', 3, '402', 10],
  ['4202', 'brand-content-operator', '内容运营', 3, '402', 20],
  ['4203', 'brand-visual-designer', '视觉设计师', 3, '402', 30],

  ['11101', 'ecommerce-product-design-doc', '产品设计文档', 4, '1101', 10],
  ['11102', 'ecommerce-prd', '产品需求文档', 4, '1101', 20],
  ['11201', 'ecommerce-ui-design-doc', 'UI 设计文档', 4, '1102', 10],
  ['11202', 'ecommerce-ux-design-doc', '用户体验设计文档', 4, '1102', 20],
  ['11301', 'ecommerce-technical-design-doc', '技术设计文档', 4, '1103', 10],
  ['11302', 'ecommerce-api-design-doc', '接口设计文档', 4, '1103', 20],
  ['11401', 'ecommerce-architecture-design-doc', '技术架构设计文档', 4, '1104', 10],
  ['11501', 'ecommerce-operation-plan', '运营方案', 4, '1105', 10],
  ['12101', 'enterprise-product-design-doc', '产品设计文档', 4, '1201', 10],
  ['12201', 'enterprise-technical-design-doc', '技术设计文档', 4, '1202', 10],
  ['12301', 'enterprise-architecture-design-doc', '技术架构设计文档', 4, '1203', 10],
  ['12401', 'enterprise-implementation-plan', '客户实施方案', 4, '1204', 10],
  ['21101', 'bank-risk-policy', '风险策略文档', 4, '2101', 10],
  ['21201', 'bank-data-analysis-report', '数据分析报告', 4, '2102', 10],
  ['21301', 'bank-financial-product-design', '金融产品设计文档', 4, '2103', 10],
  ['21401', 'bank-architecture-design-doc', '技术架构设计文档', 4, '2104', 10],
  ['22101', 'insurance-product-design', '保险产品设计文档', 4, '2201', 10],
  ['22201', 'insurance-actuarial-report', '精算分析报告', 4, '2202', 10],
  ['22301', 'insurance-claims-sop', '理赔处理 SOP', 4, '2203', 10],
  ['31101', 'smart-process-design', '工艺设计文档', 4, '3101', 10],
  ['31201', 'smart-system-design', '工业软件设计文档', 4, '3102', 10],
  ['31301', 'smart-architecture-design', '智能制造架构文档', 4, '3103', 10],
  ['32101', 'consumer-industrial-design', '工业设计文档', 4, '3201', 10],
  ['32201', 'consumer-quality-plan', '质量策划文档', 4, '3202', 10],
  ['41101', 'consulting-project-proposal', '项目建议书', 4, '4101', 10],
  ['41102', 'consulting-solution-report', '咨询方案报告', 4, '4101', 20],
  ['41201', 'consulting-industry-research', '行业研究报告', 4, '4102', 10],
  ['41301', 'consulting-project-plan', '项目管理计划', 4, '4103', 10],
  ['42101', 'brand-strategy-plan', '品牌策略方案', 4, '4201', 10],
  ['42201', 'brand-content-plan', '内容策划文档', 4, '4202', 10],
  ['42301', 'brand-visual-guideline', '视觉设计规范', 4, '4203', 10],
]

const rolePacks = {
  'digital-content': [
    { key: 'content-product-manager', name: '内容产品经理', documents: [['content-product-plan', '内容产品方案'], ['user-growth-plan', '用户增长方案']] },
    { key: 'community-operator', name: '社区运营', documents: [['community-operation-plan', '社区运营方案'], ['content-governance-guide', '内容治理规范']] },
  ],
  'cloud-ai': [
    { key: 'solution-architect', name: '解决方案架构师', documents: [['cloud-architecture-design', '云架构设计文档'], ['technical-solution', '技术解决方案']] },
    { key: 'data-ai-engineer', name: '数据与 AI 工程师', documents: [['data-platform-design', '数据平台设计文档'], ['model-evaluation-report', '模型评估报告']] },
  ],
  security: [
    { key: 'security-architect', name: '安全架构师', documents: [['security-architecture-design', '安全架构设计文档'], ['threat-model', '威胁建模报告']] },
    { key: 'security-operator', name: '安全运营工程师', documents: [['incident-response-plan', '安全事件响应预案'], ['security-audit-report', '安全审计报告']] },
  ],
  game: [
    { key: 'game-designer', name: '游戏策划', documents: [['game-design-doc', '游戏设计文档'], ['game-system-design', '玩法与数值系统设计']] },
    { key: 'game-operator', name: '游戏运营', documents: [['version-operation-plan', '版本运营方案'], ['activity-review', '活动复盘报告']] },
  ],
  'capital-market': [
    { key: 'investment-analyst', name: '投资研究员', documents: [['investment-research-report', '投资研究报告'], ['valuation-analysis', '估值分析报告']] },
    { key: 'asset-product-manager', name: '资管产品经理', documents: [['asset-product-plan', '资管产品方案'], ['information-disclosure', '信息披露文档']] },
  ],
  'finance-risk': [
    { key: 'finance-product-manager', name: '金融产品经理', documents: [['finance-product-design', '金融产品设计文档'], ['finance-product-requirement', '金融产品需求文档']] },
    { key: 'risk-manager', name: '风险经理', documents: [['risk-policy', '风险策略文档'], ['asset-quality-report', '资产质量分析报告']] },
  ],
  manufacturing: [
    { key: 'rd-engineer', name: '研发工程师', documents: [['product-technical-spec', '产品技术规格书'], ['engineering-design', '工程设计文档']] },
    { key: 'quality-engineer', name: '质量工程师', documents: [['quality-plan', '质量策划文档'], ['fmea-report', 'FMEA 分析报告']] },
  ],
  'process-ehs': [
    { key: 'process-engineer', name: '工艺工程师', documents: [['process-design', '工艺设计文档'], ['production-sop', '生产操作规程']] },
    { key: 'ehs-engineer', name: 'EHS 工程师', documents: [['ehs-risk-assessment', 'EHS 风险评估'], ['ehs-emergency-plan', 'EHS 应急预案']] },
  ],
  food: [
    { key: 'food-rd-engineer', name: '食品研发工程师', documents: [['formula-process-spec', '配方与工艺标准'], ['new-product-brief', '新品开发方案']] },
    { key: 'food-quality-manager', name: '食品质量经理', documents: [['haccp-plan', 'HACCP 计划'], ['food-quality-report', '质量分析报告']] },
  ],
  systems: [
    { key: 'systems-engineer', name: '系统工程师', documents: [['system-requirements-spec', '系统需求规格书'], ['system-design-doc', '系统设计文档']] },
    { key: 'verification-manager', name: '验证与质量经理', documents: [['verification-plan', '验证与确认计划'], ['system-risk-review', '系统风险评审报告']] },
  ],
  legal: [
    { key: 'legal-counsel', name: '律师与法务顾问', documents: [['legal-opinion', '法律意见书'], ['contract-review-memo', '合同审查意见']] },
    { key: 'ip-compliance-specialist', name: '知识产权与合规专员', documents: [['ip-analysis-report', '知识产权分析报告'], ['compliance-guideline', '合规工作指引']] },
  ],
  audit: [
    { key: 'finance-manager', name: '财务经理', documents: [['budget-plan', '全面预算方案'], ['financial-analysis-report', '财务分析报告']] },
    { key: 'auditor-tax-advisor', name: '审计与税务顾问', documents: [['audit-plan', '审计实施方案'], ['tax-planning-report', '税务筹划报告']] },
  ],
  hr: [
    { key: 'hrbp', name: 'HRBP', documents: [['organization-talent-plan', '组织与人才方案'], ['performance-plan', '绩效管理方案']] },
    { key: 'talent-development', name: '招聘与人才发展顾问', documents: [['recruitment-plan', '招聘方案'], ['training-plan', '培训发展方案']] },
  ],
  'professional-delivery': [
    { key: 'professional-consultant', name: '专业顾问', documents: [['project-proposal', '项目建议书'], ['professional-solution', '专业解决方案']] },
    { key: 'delivery-project-manager', name: '交付项目经理', documents: [['project-delivery-plan', '项目交付计划'], ['acceptance-report', '项目验收报告']] },
  ],
  'business-operations': [
    { key: 'service-designer', name: '服务方案经理', documents: [['service-solution', '服务解决方案'], ['service-process-sop', '服务流程 SOP']] },
    { key: 'delivery-operator', name: '交付运营经理', documents: [['delivery-operation-plan', '交付运营计划'], ['operation-review', '运营复盘报告']] },
  ],
  agriculture: [
    { key: 'agricultural-technician', name: '农业技术员', documents: [['planting-plan', '种植生产方案'], ['agricultural-technical-guide', '农业技术规程']] },
    { key: 'farm-operator', name: '农场运营经理', documents: [['farm-operation-plan', '农场运营计划'], ['production-analysis', '生产经营分析']] },
  ],
  livestock: [
    { key: 'veterinarian', name: '兽医与防疫专员', documents: [['disease-prevention-manual', '疫病防控手册'], ['biosecurity-plan', '生物安全方案']] },
    { key: 'breeding-manager', name: '养殖经理', documents: [['breeding-plan', '养殖生产计划'], ['breeding-sop', '标准化养殖规程']] },
  ],
  forestry: [
    { key: 'forestry-engineer', name: '林业工程师', documents: [['resource-survey-report', '森林资源调查报告'], ['ecological-conservation-plan', '生态保育方案']] },
    { key: 'forestry-operator', name: '林场运营经理', documents: [['forestry-operation-plan', '林场经营方案'], ['forest-fire-plan', '森林防火预案']] },
  ],
  fisheries: [
    { key: 'aquaculture-engineer', name: '水产养殖工程师', documents: [['aquaculture-technical-plan', '水产养殖技术方案'], ['aquatic-disease-sop', '水生动物疫病防控规程']] },
    { key: 'fishery-operator', name: '渔业运营经理', documents: [['fishery-production-plan', '渔业生产计划'], ['quality-traceability-report', '质量追溯报告']] },
  ],
  'construction-design': [
    { key: 'architect', name: '建筑师', documents: [['architectural-design-brief', '建筑设计任务书'], ['architectural-design-statement', '建筑设计说明']] },
    { key: 'specialist-engineer', name: '专业工程师', documents: [['discipline-design-plan', '专业设计方案'], ['engineering-calculation', '工程计算书']] },
  ],
  'construction-delivery': [
    { key: 'construction-project-manager', name: '工程项目经理', documents: [['construction-organization-design', '施工组织设计'], ['construction-schedule', '工程进度计划']] },
    { key: 'cost-engineer', name: '造价工程师', documents: [['project-estimate', '工程概预算书'], ['settlement-audit-report', '结算审核报告']] },
  ],
  realestate: [
    { key: 'investment-development-manager', name: '投资发展经理', documents: [['feasibility-study', '项目可行性研究报告'], ['development-positioning', '项目定位策划']] },
    { key: 'realestate-marketing-planner', name: '营销策划经理', documents: [['realestate-marketing-plan', '房地产营销方案'], ['sales-analysis-report', '销售分析报告']] },
  ],
  property: [
    { key: 'property-manager', name: '物业项目经理', documents: [['property-service-plan', '物业服务方案'], ['property-service-sop', '物业服务 SOP']] },
    { key: 'facilities-engineer', name: '设施设备工程师', documents: [['maintenance-plan', '设施维保计划'], ['facility-emergency-plan', '设施应急预案']] },
  ],
  mining: [
    { key: 'mining-engineer', name: '采矿工程师', documents: [['mine-design-plan', '矿山开采设计'], ['mining-operation-procedure', '采矿作业规程']] },
    { key: 'mine-safety-manager', name: '矿山安全经理', documents: [['mine-safety-assessment', '矿山安全评估'], ['mine-emergency-plan', '矿山应急预案']] },
  ],
  energy: [
    { key: 'petroleum-engineer', name: '油气工程师', documents: [['field-development-plan', '油气田开发方案'], ['oil-gas-operation-procedure', '油气作业规程']] },
    { key: 'hse-manager', name: 'HSE 经理', documents: [['hse-management-plan', 'HSE 管理方案'], ['hse-emergency-plan', 'HSE 应急预案']] },
  ],
  power: [
    { key: 'power-engineer', name: '电力工程师', documents: [['power-grid-plan', '电网规划方案'], ['power-system-design', '电力系统设计文档']] },
    { key: 'dispatch-operator', name: '调度运行专员', documents: [['dispatch-procedure', '调度运行规程'], ['power-incident-analysis', '电力事件分析报告']] },
  ],
  renewable: [
    { key: 'renewable-development-manager', name: '新能源开发经理', documents: [['renewable-feasibility-study', '新能源项目可研报告'], ['renewable-investment-proposal', '新能源投资建议书']] },
    { key: 'renewable-operation-engineer', name: '新能源运维工程师', documents: [['renewable-maintenance-manual', '新能源运维手册'], ['generation-performance-report', '发电绩效分析报告']] },
  ],
  transport: [
    { key: 'transport-planner', name: '运输规划师', documents: [['transport-capacity-plan', '运输能力规划'], ['transport-dispatch-plan', '运输调度方案']] },
    { key: 'transport-safety-manager', name: '运输安全经理', documents: [['transport-safety-plan', '运输安全方案'], ['transport-emergency-plan', '运输应急预案']] },
  ],
  aviation: [
    { key: 'aviation-controller', name: '航空运行控制员', documents: [['aviation-operation-manual', '航空运行手册'], ['flight-operation-plan', '航班运行方案']] },
    { key: 'aircraft-maintenance-engineer', name: '航空维修工程师', documents: [['aircraft-maintenance-program', '航空器维修方案'], ['aircraft-fault-analysis', '航空器故障分析报告']] },
  ],
  shipping: [
    { key: 'shipping-operator', name: '航运运营经理', documents: [['voyage-plan', '航次计划'], ['shipping-operation-sop', '航运操作规程']] },
    { key: 'port-planner', name: '港口运营规划师', documents: [['terminal-operation-plan', '码头运营方案'], ['port-capacity-analysis', '港口能力分析报告']] },
  ],
  supplychain: [
    { key: 'supply-chain-planner', name: '供应链规划师', documents: [['supply-chain-network-plan', '供应链网络规划'], ['sales-operation-plan', '产销协同计划']] },
    { key: 'warehouse-manager', name: '仓储经理', documents: [['warehouse-operation-plan', '仓储运营方案'], ['inventory-analysis-report', '库存分析报告']] },
  ],
  logistics: [
    { key: 'route-planner', name: '线路规划师', documents: [['delivery-route-plan', '配送线路方案'], ['logistics-capacity-plan', '物流运力计划']] },
    { key: 'delivery-operator', name: '配送运营经理', documents: [['delivery-service-sop', '配送服务 SOP'], ['delivery-operation-review', '配送运营复盘']] },
  ],
  retail: [
    { key: 'merchandise-manager', name: '商品经理', documents: [['assortment-plan', '商品组合规划'], ['merchandising-plan', '商品陈列方案']] },
    { key: 'store-operator', name: '门店运营经理', documents: [['store-operation-manual', '门店运营手册'], ['retail-sales-review', '零售经营复盘']] },
  ],
  trade: [
    { key: 'trade-manager', name: '贸易业务经理', documents: [['trade-business-plan', '贸易业务方案'], ['commercial-proposal', '商务报价方案']] },
    { key: 'customs-compliance-specialist', name: '关务与合规专员', documents: [['customs-operation-guide', '关务操作指引'], ['trade-compliance-report', '贸易合规报告']] },
  ],
  education: [
    { key: 'instructional-designer', name: '课程与教学设计师', documents: [['curriculum-outline', '课程大纲'], ['lesson-plan', '教学设计方案']] },
    { key: 'teaching-researcher', name: '教研员', documents: [['curriculum-standard', '课程标准'], ['teaching-evaluation-report', '教学评估报告']] },
  ],
  'higher-education': [
    { key: 'faculty-researcher', name: '高校教师与研究员', documents: [['academic-research-proposal', '学术研究计划'], ['academic-paper-outline', '学术论文提纲']] },
    { key: 'academic-manager', name: '教务与学科管理员', documents: [['program-development-plan', '专业建设方案'], ['program-evaluation-report', '学科评估报告']] },
  ],
  clinical: [
    { key: 'clinician', name: '临床医师', documents: [['clinical-pathway', '临床诊疗路径'], ['case-discussion', '病例讨论报告']] },
    { key: 'nursing-quality-manager', name: '护理与质量管理人员', documents: [['nursing-sop', '护理操作规范'], ['clinical-quality-improvement', '医疗质量改进报告']] },
  ],
  pharma: [
    { key: 'clinical-researcher', name: '临床研究员', documents: [['clinical-trial-protocol', '临床试验方案'], ['clinical-study-report', '临床研究报告']] },
    { key: 'regulatory-affairs', name: '注册与药政专员', documents: [['registration-dossier', '药品注册申报资料'], ['pharmacovigilance-report', '药物警戒报告']] },
  ],
  'medical-device': [
    { key: 'medical-device-rd', name: '医疗器械研发工程师', documents: [['medical-device-requirement', '产品技术要求'], ['design-development-record', '设计开发文档']] },
    { key: 'medical-device-quality', name: '质量与注册专员', documents: [['medical-device-risk-report', '风险管理报告'], ['device-registration-dossier', '器械注册申报资料']] },
  ],
  care: [
    { key: 'health-manager', name: '健康管理师', documents: [['health-intervention-plan', '健康干预方案'], ['health-assessment-report', '健康评估报告']] },
    { key: 'care-operator', name: '康养服务运营', documents: [['care-service-plan', '照护服务计划'], ['care-service-sop', '康养服务 SOP']] },
  ],
  publishing: [
    { key: 'editor-reporter', name: '编辑与记者', documents: [['editorial-plan', '选题策划案'], ['feature-report', '专题报道稿']] },
    { key: 'publishing-producer', name: '出版制作人', documents: [['publishing-plan', '出版策划方案'], ['manuscript-review', '书稿审读意见']] },
  ],
  'media-production': [
    { key: 'director-producer', name: '编导与制片人', documents: [['production-proposal', '节目制作方案'], ['shooting-script', '拍摄脚本']] },
    { key: 'post-production-manager', name: '后期制作经理', documents: [['post-production-plan', '后期制作方案'], ['production-review', '制作复盘报告']] },
  ],
  advertising: [
    { key: 'advertising-planner', name: '广告与公关策划', documents: [['creative-brief', '创意简报'], ['campaign-plan', '整合传播方案']] },
    { key: 'account-manager', name: '客户与项目经理', documents: [['pitch-proposal', '客户提案'], ['campaign-review', '传播项目复盘']] },
  ],
  sports: [
    { key: 'event-planner', name: '赛事活动策划', documents: [['event-plan', '赛事活动方案'], ['event-execution-manual', '赛事执行手册']] },
    { key: 'coach-operator', name: '教练与场馆运营', documents: [['training-plan', '训练计划'], ['venue-operation-plan', '场馆运营方案']] },
  ],
  culture: [
    { key: 'curator', name: '策展人与研究员', documents: [['exhibition-curatorial-plan', '展览策划方案'], ['collection-research-report', '藏品研究报告']] },
    { key: 'public-education-specialist', name: '公共教育专员', documents: [['public-education-program', '公共教育方案'], ['cultural-event-review', '文化活动复盘']] },
  ],
  tourism: [
    { key: 'tourism-product-planner', name: '旅游产品策划', documents: [['tour-route-plan', '旅游线路策划'], ['destination-plan', '目的地运营方案']] },
    { key: 'tour-operator', name: '旅行服务运营', documents: [['tour-service-manual', '旅行服务手册'], ['tourism-emergency-plan', '旅游安全应急预案']] },
  ],
  hotel: [
    { key: 'revenue-manager', name: '收益与市场经理', documents: [['hotel-revenue-strategy', '酒店收益策略'], ['hotel-operation-analysis', '酒店经营分析']] },
    { key: 'hotel-operator', name: '酒店运营经理', documents: [['hotel-service-standard', '酒店服务标准'], ['hotel-quality-report', '酒店质量检查报告']] },
  ],
  foodservice: [
    { key: 'foodservice-product-manager', name: '餐饮产品经理', documents: [['menu-development-plan', '菜单研发方案'], ['standard-recipe', '标准配方与工艺卡']] },
    { key: 'restaurant-operator', name: '餐饮门店运营', documents: [['restaurant-operation-manual', '餐厅运营手册'], ['food-safety-plan', '食品安全管理方案']] },
  ],
  leisure: [
    { key: 'venue-planner', name: '景区与休闲项目策划', documents: [['leisure-operation-plan', '景区运营方案'], ['visitor-experience-plan', '游客体验提升方案']] },
    { key: 'leisure-safety-operator', name: '安全运营经理', documents: [['leisure-safety-manual', '景区安全手册'], ['leisure-emergency-plan', '景区应急预案']] },
  ],
  'public-policy': [
    { key: 'policy-researcher', name: '政策研究人员', documents: [['policy-research-report', '政策研究报告'], ['policy-drafting-note', '政策起草说明']] },
    { key: 'government-project-manager', name: '政府项目管理人员', documents: [['policy-implementation-plan', '政策实施方案'], ['performance-evaluation-report', '绩效评价报告']] },
  ],
  'public-service': [
    { key: 'public-service-manager', name: '公共服务管理人员', documents: [['public-service-guide', '公共服务办事指南'], ['service-improvement-plan', '公共服务改进方案']] },
    { key: 'community-worker', name: '社区工作者', documents: [['community-program-plan', '社区项目方案'], ['case-work-record', '个案工作记录']] },
  ],
  emergency: [
    { key: 'emergency-planner', name: '应急管理人员', documents: [['emergency-response-plan', '突发事件应急预案'], ['emergency-drill-plan', '应急演练方案']] },
    { key: 'public-safety-supervisor', name: '公共安全监督人员', documents: [['risk-inventory', '安全风险清单'], ['incident-investigation-report', '事故调查报告']] },
  ],
  telecom: [
    { key: 'network-architect', name: '通信网络架构师', documents: [['network-planning', '通信网络规划'], ['network-technical-design', '网络技术设计文档']] },
    { key: 'network-operator', name: '网络运维工程师', documents: [['network-maintenance-manual', '网络维护手册'], ['network-fault-review', '网络故障复盘']] },
  ],
  datacenter: [
    { key: 'infrastructure-architect', name: '基础设施架构师', documents: [['datacenter-architecture', '数据中心架构设计'], ['datacenter-capacity-plan', '数据中心容量规划']] },
    { key: 'sre-engineer', name: '可靠性工程师', documents: [['sre-operation-manual', '可靠性运维手册'], ['incident-review', '生产事故复盘']] },
  ],
  environment: [
    { key: 'environmental-engineer', name: '环境工程师', documents: [['environmental-treatment-plan', '环境治理方案'], ['environmental-impact-assessment', '环境影响评价报告']] },
    { key: 'environment-operation-manager', name: '环保运营经理', documents: [['environment-operation-manual', '环保设施运营手册'], ['environment-monitoring-report', '环境监测报告']] },
  ],
  science: [
    { key: 'researcher', name: '科研人员', documents: [['research-proposal', '科研项目研究方案'], ['research-report', '科研成果报告']] },
    { key: 'research-manager', name: '科研项目管理人员', documents: [['research-application', '科研项目申报书'], ['project-conclusion-report', '科研项目结题报告']] },
  ],
  inspection: [
    { key: 'inspection-engineer', name: '检验检测工程师', documents: [['inspection-procedure', '检验检测作业指导书'], ['inspection-report', '检验检测报告']] },
    { key: 'certification-auditor', name: '认证审核员', documents: [['certification-audit-plan', '认证审核计划'], ['certification-report', '认证审核报告']] },
  ],
  nonprofit: [
    { key: 'nonprofit-program-manager', name: '公益项目经理', documents: [['nonprofit-program-plan', '公益项目方案'], ['social-impact-assessment', '社会影响力评估']] },
    { key: 'fundraising-communications', name: '筹款与传播专员', documents: [['fundraising-plan', '筹款方案'], ['nonprofit-annual-report', '公益组织年度报告']] },
  ],
  association: [
    { key: 'industry-researcher', name: '行业研究与标准专员', documents: [['industry-white-paper', '行业白皮书'], ['industry-standard-proposal', '团体标准立项书']] },
    { key: 'member-operator', name: '会员服务运营', documents: [['member-service-plan', '会员服务方案'], ['association-annual-plan', '协会年度工作计划']] },
  ],
  'social-work': [
    { key: 'social-worker', name: '社会工作者', documents: [['case-service-plan', '个案服务计划'], ['case-assessment-report', '个案评估报告']] },
    { key: 'social-service-supervisor', name: '社会服务督导', documents: [['social-service-program', '社会服务项目方案'], ['social-service-evaluation', '社会服务评估报告']] },
  ],
  'personal-service': [
    { key: 'personal-service-designer', name: '服务方案设计师', documents: [['personal-service-plan', '客户服务方案'], ['personal-service-standard', '服务质量标准']] },
    { key: 'personal-service-operator', name: '门店与服务运营', documents: [['personal-operation-manual', '门店运营手册'], ['customer-satisfaction-report', '客户满意度分析']] },
  ],
  strategy: [
    { key: 'corporate-strategist', name: '战略规划经理', documents: [['corporate-strategy-plan', '企业战略规划'], ['management-diagnostic-report', '管理诊断报告']] },
    { key: 'business-operator', name: '经营管理人员', documents: [['annual-operation-plan', '年度经营计划'], ['business-review', '经营分析复盘']] },
  ],
  'corporate-finance': [
    { key: 'corporate-finance-manager', name: '企业财务经理', documents: [['corporate-budget-plan', '企业预算方案'], ['corporate-financial-analysis', '企业财务分析']] },
    { key: 'accounting-manager', name: '会计与核算经理', documents: [['accounting-policy', '会计核算制度'], ['closing-report', '月度结账报告']] },
  ],
  'marketing-sales': [
    { key: 'marketing-manager', name: '市场经理', documents: [['marketing-plan', '市场营销方案'], ['market-research-report', '市场调研报告']] },
    { key: 'sales-manager', name: '销售经理', documents: [['sales-plan', '销售行动计划'], ['key-account-proposal', '大客户解决方案']] },
  ],
  procurement: [
    { key: 'procurement-manager', name: '采购经理', documents: [['sourcing-strategy', '采购寻源策略'], ['tender-document', '招标采购文件']] },
    { key: 'supplier-manager', name: '供应商管理人员', documents: [['supplier-assessment', '供应商评估报告'], ['supplier-improvement-plan', '供应商改进方案']] },
  ],
  'corporate-it': [
    { key: 'enterprise-architect', name: '企业架构师', documents: [['enterprise-it-architecture', '企业 IT 架构规划'], ['digital-transformation-plan', '数字化转型方案']] },
    { key: 'data-security-manager', name: '数据与安全管理人员', documents: [['data-governance-plan', '数据治理方案'], ['information-security-policy', '信息安全制度']] },
  ],
} satisfies Record<string, readonly RoleSpec[]>

type RolePackKey = keyof typeof rolePacks
type IndustrySpec = readonly [suffix: string, key: string, name: string, sortOrder: number]
type SegmentSpec = readonly [suffix: string, key: string, name: string, parentSuffix: string, sortOrder: number, pack: RolePackKey]

const expandedIndustries: readonly IndustrySpec[] = [
  ['5', 'agriculture-forestry-fishery', '农林牧渔', 50],
  ['6', 'construction-realestate', '建筑与房地产', 60],
  ['7', 'energy-mining', '能源与矿业', 70],
  ['8', 'transport-logistics', '交通运输与物流', 80],
  ['9', 'wholesale-retail-trade', '批发零售与贸易', 90],
  ['10', 'education-training', '教育与培训', 100],
  ['11', 'healthcare-life-science', '医疗健康与生命科学', 110],
  ['12', 'culture-media-sports', '文化传媒与文体娱乐', 120],
  ['13', 'tourism-hospitality-catering', '旅游、酒店与餐饮', 130],
  ['14', 'government-public-service', '政府与公共服务', 140],
  ['15', 'telecom-communication', '电信与通信', 150],
  ['16', 'environment-utilities', '环保与公用事业', 160],
  ['17', 'research-testing', '科研、检测与认证', 170],
  ['18', 'social-nonprofit', '社会组织与非营利', 180],
  ['19', 'life-personal-service', '生活与个人服务', 190],
  ['20', 'corporate-functions', '通用企业职能', 200],
]

const expandedSegments: readonly SegmentSpec[] = [
  ['103', 'internet-consumer-platform', '内容社区与消费平台', '1', 30, 'digital-content'],
  ['104', 'internet-cloud-data-ai', '云计算、数据与人工智能', '1', 40, 'cloud-ai'],
  ['105', 'internet-cybersecurity', '网络安全', '1', 50, 'security'],
  ['106', 'internet-gaming', '游戏与数字娱乐', '1', 60, 'game'],
  ['203', 'finance-securities-fund', '证券、基金与资产管理', '2', 30, 'capital-market'],
  ['204', 'finance-fintech', '金融科技', '2', 40, 'finance-risk'],
  ['205', 'finance-leasing-consumer', '融资租赁与消费金融', '2', 50, 'finance-risk'],
  ['303', 'manufacturing-automotive', '汽车与零部件', '3', 30, 'manufacturing'],
  ['304', 'manufacturing-electronics-semiconductor', '电子与半导体', '3', 40, 'manufacturing'],
  ['305', 'manufacturing-equipment-machinery', '机械与高端装备', '3', 50, 'manufacturing'],
  ['306', 'manufacturing-materials-chemical', '材料与化工', '3', 60, 'process-ehs'],
  ['307', 'manufacturing-food-beverage', '食品与饮料制造', '3', 70, 'food'],
  ['308', 'manufacturing-aerospace-defense', '航空航天与国防装备', '3', 80, 'systems'],
  ['403', 'professional-legal-ip', '法律与知识产权', '4', 30, 'legal'],
  ['404', 'professional-accounting-audit-tax', '财会、审计与税务', '4', 40, 'audit'],
  ['405', 'professional-hr-recruitment', '人力资源与招聘', '4', 50, 'hr'],
  ['406', 'professional-engineering-design', '工程设计与技术服务', '4', 60, 'professional-delivery'],
  ['407', 'professional-business-outsourcing', '商务与外包服务', '4', 70, 'business-operations'],
  ['5001', 'agriculture-crop', '种植业', '5', 10, 'agriculture'],
  ['5002', 'agriculture-livestock', '畜牧养殖', '5', 20, 'livestock'],
  ['5003', 'agriculture-forestry', '林业与生态保育', '5', 30, 'forestry'],
  ['5004', 'agriculture-fisheries', '渔业与水产养殖', '5', 40, 'fisheries'],
  ['6001', 'construction-architecture-design', '建筑规划与设计', '6', 10, 'construction-design'],
  ['6002', 'construction-engineering', '工程建设与施工', '6', 20, 'construction-delivery'],
  ['6003', 'construction-realestate-development', '房地产开发与营销', '6', 30, 'realestate'],
  ['6004', 'construction-property-facility', '物业与设施管理', '6', 40, 'property'],
  ['7001', 'energy-coal-mining', '煤炭与矿业', '7', 10, 'mining'],
  ['7002', 'energy-oil-gas', '石油与天然气', '7', 20, 'energy'],
  ['7003', 'energy-power-grid', '电力与电网', '7', 30, 'power'],
  ['7004', 'energy-renewable', '新能源与储能', '7', 40, 'renewable'],
  ['8001', 'transport-road-rail', '公路、铁路与城市交通', '8', 10, 'transport'],
  ['8002', 'transport-aviation', '航空运输', '8', 20, 'aviation'],
  ['8003', 'transport-shipping-port', '航运与港口', '8', 30, 'shipping'],
  ['8004', 'transport-warehouse-supplychain', '仓储与供应链', '8', 40, 'supplychain'],
  ['8005', 'transport-express-delivery', '快递与同城配送', '8', 50, 'logistics'],
  ['9001', 'retail-offline', '商超、百货与专卖零售', '9', 10, 'retail'],
  ['9002', 'trade-wholesale', '批发与国内贸易', '9', 20, 'trade'],
  ['9003', 'trade-crossborder', '进出口与跨境贸易', '9', 30, 'trade'],
  ['9004', 'retail-fmcg-distribution', '消费品流通与经销', '9', 40, 'retail'],
  ['10001', 'education-k12', '学前与 K12 教育', '10', 10, 'education'],
  ['10002', 'education-higher', '高等教育', '10', 20, 'higher-education'],
  ['10003', 'education-vocational', '职业教育', '10', 30, 'education'],
  ['10004', 'education-training-edtech', '成人培训与教育科技', '10', 40, 'education'],
  ['11001', 'healthcare-hospital-clinic', '医院与基层医疗', '11', 10, 'clinical'],
  ['11002', 'healthcare-pharma-biotech', '医药与生物科技', '11', 20, 'pharma'],
  ['11003', 'healthcare-medical-device', '医疗器械', '11', 30, 'medical-device'],
  ['11004', 'healthcare-health-eldercare', '健康管理与养老康复', '11', 40, 'care'],
  ['12001', 'culture-news-publishing', '新闻与出版', '12', 10, 'publishing'],
  ['12002', 'culture-film-tv-audio', '影视、音视频与制作', '12', 20, 'media-production'],
  ['12003', 'culture-advertising-pr', '广告、公关与传播', '12', 30, 'advertising'],
  ['12004', 'culture-sports-events', '体育、赛事与场馆', '12', 40, 'sports'],
  ['12005', 'culture-art-museum', '艺术、博物馆与文化机构', '12', 50, 'culture'],
  ['13001', 'tourism-travel-service', '旅行社与旅游服务', '13', 10, 'tourism'],
  ['13002', 'tourism-hotel-lodging', '酒店与住宿', '13', 20, 'hotel'],
  ['13003', 'tourism-foodservice', '餐饮与连锁门店', '13', 30, 'foodservice'],
  ['13004', 'tourism-scenic-leisure', '景区与休闲度假', '13', 40, 'leisure'],
  ['14001', 'government-agency-policy', '党政机关与政策管理', '14', 10, 'public-policy'],
  ['14002', 'government-public-institution-community', '事业单位与社区服务', '14', 20, 'public-service'],
  ['14003', 'government-emergency-public-safety', '应急管理与公共安全', '14', 30, 'emergency'],
  ['15001', 'telecom-operator', '电信运营商', '15', 10, 'telecom'],
  ['15002', 'telecom-equipment', '通信设备与网络工程', '15', 20, 'systems'],
  ['15003', 'telecom-satellite', '卫星通信与低空信息服务', '15', 30, 'systems'],
  ['15004', 'telecom-idc-infrastructure', '数据中心与数字基础设施', '15', 40, 'datacenter'],
  ['16001', 'utilities-water', '供水与污水处理', '16', 10, 'environment'],
  ['16002', 'environment-waste-sanitation', '固废、环卫与资源回收', '16', 20, 'environment'],
  ['16003', 'environment-governance-consulting', '环境治理与环保服务', '16', 30, 'environment'],
  ['16004', 'utilities-gas-heat', '燃气、供热与综合公用事业', '16', 40, 'energy'],
  ['17001', 'research-basic-science', '基础科学与自然科学研究', '17', 10, 'science'],
  ['17002', 'research-industrial-rd', '产业技术研发', '17', 20, 'science'],
  ['17003', 'research-inspection-certification', '检验检测与认证', '17', 30, 'inspection'],
  ['17004', 'research-laboratory', '实验室与科研平台', '17', 40, 'science'],
  ['18001', 'nonprofit-foundation-charity', '基金会、慈善与公益组织', '18', 10, 'nonprofit'],
  ['18002', 'nonprofit-association-chamber', '行业协会与商会', '18', 20, 'association'],
  ['18003', 'nonprofit-social-work', '社会工作与社会服务', '18', 30, 'social-work'],
  ['19001', 'life-household-service', '家政与家庭服务', '19', 10, 'personal-service'],
  ['19002', 'life-beauty-wellness', '美容美发与身心健康', '19', 20, 'personal-service'],
  ['19003', 'life-repair-maintenance', '维修与便民服务', '19', 30, 'personal-service'],
  ['19004', 'life-wedding-event', '婚庆与活动服务', '19', 40, 'personal-service'],
  ['19005', 'life-pet-service', '宠物与伴侣动物服务', '19', 50, 'personal-service'],
  ['20001', 'corporate-strategy-management', '战略与经营管理', '20', 10, 'strategy'],
  ['20002', 'corporate-finance-accounting', '财务与会计', '20', 20, 'corporate-finance'],
  ['20003', 'corporate-hr-administration', '人力资源与行政', '20', 30, 'hr'],
  ['20004', 'corporate-marketing-sales', '市场、销售与商务拓展', '20', 40, 'marketing-sales'],
  ['20005', 'corporate-procurement-supplychain', '采购与供应链管理', '20', 50, 'procurement'],
  ['20006', 'corporate-legal-compliance', '法务、合规与风控', '20', 60, 'legal'],
  ['20007', 'corporate-it-data-security', 'IT、数据与信息安全', '20', 70, 'corporate-it'],
]

const rows: CategoryRow[] = [...baseRows]

for (const [suffix, key, name, sortOrder] of expandedIndustries) {
  rows.push([suffix, key, name, 1, null, sortOrder])
}

for (const [suffix, key, name, parentSuffix, sortOrder, pack] of expandedSegments) {
  rows.push([suffix, key, name, 2, parentSuffix, sortOrder])
  rolePacks[pack].forEach((role, roleIndex) => {
    const roleSuffix = `${suffix}${roleIndex + 1}`
    const roleKey = `${key}-${role.key}`
    rows.push([roleSuffix, roleKey, role.name, 3, suffix, (roleIndex + 1) * 10])
    role.documents.forEach(([documentKey, documentName], documentIndex) => {
      rows.push([
        `${roleSuffix}${documentIndex + 1}`,
        `${roleKey}-${documentKey}`,
        documentName,
        4,
        roleSuffix,
        (documentIndex + 1) * 10,
      ])
    })
  })
}

export const OFFLINE_CREATION_SKILL_CATEGORIES: CreationSkillCategory[] = rows.map(([
  suffix,
  key,
  name,
  level,
  parentSuffix,
  sortOrder,
]) => ({
  id: categoryId(suffix),
  key,
  name,
  level,
  parentId: parentSuffix ? categoryId(parentSuffix) : null,
  sortOrder,
}))
