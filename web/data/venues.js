// 坐标在原图上逐个放大标定（2026-11-26）：剧场取建筑本体中心，出入口 / 售票 / 服务中心 / 码头取图标中心，
// 其余地标取图上文字或建筑中心。px/py = img/map.jpg 原图像素坐标（1280×2275，未旋转，左上角为原点）。
window.LZM_VENUES = [
  { id: 'magic',   name: '魔术剧场',       px: 392, py: 345 },
  { id: 'kungfu',  name: '功夫传奇剧场',   px: 548, py: 372 },
  { id: 'variety', name: '综艺秀剧场',     px: 564, py: 569 },
  // 红牌压在锦湖湖面上，取红牌中心。
  { id: 'xishi',   name: '千秋美人·西施',  px: 356, py: 929 },
  { id: 'kids',    name: '全息儿童剧场',   px: 612, py: 1168 },
  { id: 'film',    name: '影视揭秘剧场',   px: 782, py: 1132 },
  { id: 'ice',     name: '冰秀剧场',       px: 797, py: 1300 },
  { id: 'zuimei',  name: '醉美太湖剧场',   px: 565, py: 1435 },
  { id: 'acrobat', name: '杂技剧场',       px: 818, py: 1499 },
  { id: 'liyuan',  name: '太湖梨园剧场',   px: 388, py: 1518 },
  { id: 'music',   name: '音乐广场',       px: 891, py: 2094 },
  // 图上没标铁花秀。地点出处：腾讯新闻 2026-04-13「鲤鱼门风情街，这里是《太湖铁花秀》的举办地」、
  // 搜狐 2025-04-02「《打铁花》：位置固定在太湖古镇鲤鱼门风情街」。取图上「鲤鱼门风情街」字样中段。
  { id: 'ironflower', name: '鲤鱼门风情街', px: 830, py: 840 },
];

// 出入口等参照点：校准时给用户认位置用。
window.LZM_POIS = [
  { type: 'entrance', name: '1号出入口(东门)',          px: 615, py: 1756 },
  { type: 'entrance', name: '2号出入口(B1F)',           px: 676, py: 1781 },
  { type: 'entrance', name: '3号出入口(B1F)',           px: 330, py: 1408 },
  { type: 'entrance', name: '4号出入口(B1F)',           px: 767, py: 1434 },
  { type: 'entrance', name: '5号出入口(B2F)',           px: 953, py: 1185 },
  { type: 'entrance', name: '6号出入口(B1F)',           px: 634, py: 808 },
  { type: 'entrance', name: '7号出入口(B1F)',           px: 707, py: 740 },
  { type: 'entrance', name: '8号出入口(B2F)',           px: 927, py: 786 },
  { type: 'entrance', name: '9号出入口(B1F)',           px: 330, py: 441 },
  { type: 'entrance', name: '10号出入口(西门)',         px: 674, py: 150 },
  { type: 'entrance', name: '11号出入口(音乐广场)',     px: 599, py: 2056 },
  { type: 'entrance', name: '12号出入口(通往古镇酒店)', px: 208, py: 1285 },
  { type: 'entrance', name: '13号出入口(通往瑞峰酒店)', px: 208, py: 560 },

  { type: 'service',  name: '游客服务中心',             px: 717, py: 1731 },
  { type: 'ticket',   name: '售票处(西)',               px: 569, py: 164 },
  { type: 'ticket',   name: '售票处(东)',               px: 556, py: 1700 },
  { type: 'pier',     name: '桃花岛码头',               px: 1031, py: 1143 },

  { type: 'landmark', name: '锦湖桥',                   px: 488, py: 750 },
  { type: 'landmark', name: '同心桥',                   px: 669, py: 767 },
  { type: 'landmark', name: '九鼎桥',                   px: 985, py: 970 },
  { type: 'landmark', name: '万佛塔',                   px: 740, py: 927 },
  { type: 'landmark', name: '长兴卧龙寺',               px: 772, py: 1002 },
  { type: 'landmark', name: '观音殿',                   px: 610, py: 998 },
  { type: 'landmark', name: '孔庙',                     px: 610, py: 866 },
  { type: 'landmark', name: '烟花楼酒店',               px: 1014, py: 735 },
  { type: 'landmark', name: '桃花岛',                   px: 1109, py: 1409 },
  { type: 'landmark', name: '酒吧街',                   px: 925, py: 1851 },
  { type: 'landmark', name: '民国广场',                 px: 800, py: 602 },
  { type: 'landmark', name: '西广场',                   px: 672, py: 230 },
  { type: 'landmark', name: '东广场',                   px: 672, py: 1632 },
  { type: 'landmark', name: '盛世广场',                 px: 609, py: 1262 },
  { type: 'landmark', name: '雅仕湖畔停车场',           px: 552, py: 2174 },
  { type: 'landmark', name: '瑞峰国际大酒店',           px: 73, py: 531 },
  { type: 'landmark', name: '古镇大酒店',               px: 71, py: 1325 },
];
