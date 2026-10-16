// chrome-hello.js — 一个真实 Chrome ClientHello 的逐字节转写。
//
// 来源：用 curl_cffi 的 chrome146 档位真抓的握手包（本地监听收第一个 record）。
// 密码套件列表、扩展体、GREASE 取值全部原样照搬；每次连接必然变化的 random(32B) /
// session_id(32B) / SNI / key_share 公钥留成变量。
//
// **扩展顺序不照搬，而是复刻洗牌算法**：真 Chrome 每次连接都会重排扩展顺序，实测
// curl_cffi 的 chrome146 连打 6 次拿到 6 个不同的 JA3 字符串，而 JA4 六次完全相同
// （t13d1516h2_8daaf6152771_d8a2da3f94cd）。也就是说 JA3 对现代 Chrome 根本不是稳定
// 指纹——这正是当初发明 JA4 的原因。固定一个顺序反而是破绽（真 Chrome 从不重复），
// 所以这里按 BoringSSL 的 ssl_setup_extension_permutation 做同样的 Fisher-Yates。
//
// 为什么不自己按 JA3 字符串拼一个：JA3 只记录类型 ID 的序列，拼出来的东西 JA3 能对上，
// 但字节层面（扩展体、GREASE 的用法）仍是仿冒品。照搬真包连扩展体都一致。
//
// 注意 key_share：真包里有 1216 字节的 X25519MLKEM768（后量子混合）共享，我们算不出它的
// 共享密钥，必须删掉这一条——supported_groups 里保留 4588，所以 JA3 的曲线组字段不受影响。

export const CHROME_MAJOR = 146;
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
export const SEC_CH_UA = '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"';

export const LEGACY_VERSION = 0x0303;
export const CIPHERS = [0x3a3a, 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035];
export const COMPRESSION = [0x00];

// 扩展按真实握手包里的先后顺序。kind：raw 原样照搬 / sni / keyshare / alpn / groups
export const EXTENSIONS = [
  { t: 0xcaca, kind: 'grease1', b: '' },
  { t: 0xfe0d, kind: 'raw', b: '0000010001e00020314d4fe36e85e9be7c7f50e9d854ace87c80f20e4f482c574a8eb4d7231c154300f04836e8abd39ea991f62627b80ef19aadf1917be0e2bc0702e0a2a892accbc319ff4c270dc6cd5a166fa4e700506b53108d61789bc26a35b6160f27088aa3a1be648f902a3cee8a47bc1d2462e1e12e9eaf8506264a69499cc5b83649591cbaa5f524bee0054df22fd15dc60f70e1f278b9a0944875e5bbafc2582f5b59a3fb47e2b187865eec3387d2c57b3e95ed6ab04fbed8392624ad70d9e750754883ffe1fc0134b1971751da1eea5fb344735d2d0efb1bd04d026bb773bc2a51027b620a04c38d04b167dbf5ef7732edb80a481702f149e5eb532cc63a49107235ee2a80f4f3d50008a7672011e5ea693f039373' },
  { t: 0x000b, kind: 'raw', b: '0100' },
  { t: 0x0023, kind: 'raw', b: '' },
  { t: 0x0033, kind: 'keyshare', greaseGroup: 0xfafa, pqGroup: 0x11ec, pqBody: '2fb555750a45cec288650aaaa45320266952956148e463914718bd5d35288221b629b51f6b38adb3452ec0e7b010d0c046f3c7781314c5d32405db1bd39aa2654bb1948aad24f21cced58f9a8b42bc5206c054c712ab84dd6a6e522abeb18b4552eb93f0597d7a059358ab5cc80093f5ca8bd14961c650c502a27fe7604d97ac7c1019c6b22482d9266ecfa48c23aca21f928d3da66171b34320a370e3070f0ae9c2f7a9aa6379aa7c53a58fca2025cab5402b6df385beb5f7ba5dda0b9e20560a0595c167b2dcb69be8b05aa117aeb8c60f9e57cf1547b583d11f63250d29372cd3ba955426cce4a03f769657bb46c53c282ba588053acc9f357169894985e073c7fcaa8b2736c2efa79481b3c56cbc1a5f979327683defc515ee434e0aa787f59b6facdc81bbd487b9f4325905afa3e1282fdabc8f615a768b2a62a30859d2a63a96a9c5227942ea8d042014fed1543940ace993204b976ea2e3ab1925b785e9238f9065d711c2a6b5146a6a4101dbc63b9a659e25c3039a36788605b8fa89e075b378c284ba1708fe944d2db91a327595a84a4c6536891ac15647880f4aa410bb689acf9078c4f0b7edb153f8684b33600c893261ba8b9598270559bb20f880a56c7309849717ba5aa9953176b6cc54c5b86640c5b3d67655452137ff6a2724a3c9f59a3b2d5b10868c1f17db1449d98297b60365eba0f8d800dad4b9ec1a0a78e3652afb40e6694d35878c40f47e50e43749c994ca179e7a9b60d595a8f807b133647ca093c4ac4017d3a2c47b41131b25462af6677fdc63fdd85bee3cad359c266881b6dc6c07028a12bf46c81fa4a853361e2a63c8418701647a450beba4c0265151a7369b33cbdcbcb45f7a17944b5655c2773df44acdeb2c172220da3b611105a4e2204545d66ba948a5965c51b592825e60b808a639627b5acfa171bb6160ea412a5079aff6410d8ebb160b59ce829646470b6a0b750df86609a9c3628d757207051b7695016ba7b664f9354b3c74ef096682e104e8ca45ae97539e3b666c53972c626fd2a0c99b3bac44d86cf16827f1e447c27a1c750134e9361f03614a82631525e74da4021818561e248a441673049a97b9c47b2ab9ea02b9928db3c9226d1b8d7c5b5977896486bcce70902229d66e28b219d610c8397c14c06758a718414c193f2559c5c935b09249c566b702d7f6cd15e539ba6310cf59b0c164069850c24598cd6ecc4094163200a705f5172ab2163ddc295494b66237934bc561c741a6619e12592820bd3343b14f3a0e4d78980368212a943a0f3232f6698c0a44bfa558b4b75a36a6e33546a715d9243ac706cd29f3c41ec34b3d22bb4b45193475641bf9cf086a3671d408fe5b937edc567781343576bdd1cb0832763b53bc8e2786031a168a963b79cfd23e03f315b4c6b592d68c6126c9251664ec110960ebc65a2096fe5aabe05acf6c2152e0a5c815f0224d7b1abf20227dd136f452c4317433218832d2333d5e2a7dd6f035695a698539b146037b83224ec963ada573676a73c7a684661ce62f915abd9d91c1320cc0145430582c93fcc155e4e36d9c410cea906032e192804803b3a1797731823216323ee50016fc43f7e648b87dfff3646b249bc88a695e01bfce2b2d7152ac6694a56e2aa2344f1a51868ee9d9a096860d5b63e59bc573ce6b754bb914dd1e4c2e321ec81e24cd3487eb6b', x25519Group: 0x001d },
  { t: 0x002d, kind: 'raw', b: '0101' },
  { t: 0x0017, kind: 'raw', b: '' },
  { t: 0x002b, kind: 'raw', b: '06aaaa03040303' },
  { t: 0x0005, kind: 'raw', b: '0100000000' },
  { t: 0x0012, kind: 'raw', b: '' },
  { t: 0x44cd, kind: 'raw', b: '0003026832' },
  { t: 0x0000, kind: 'sni' },
  { t: 0x000a, kind: 'groups', groups: [0xfafa, 0x11ec, 0x001d, 0x0017, 0x0018] },
  { t: 0x000d, kind: 'raw', b: '001004030804040105030805050108060601' },
  { t: 0x0010, kind: 'alpn', protocols: ['h2', 'http/1.1'] },
  { t: 0xff01, kind: 'raw', b: '00' },
  { t: 0x001b, kind: 'raw', b: '020002' },
  { t: 0xeaea, kind: 'grease2', b: '00' },
];

// BoringSSL 的规范扩展表顺序（ssl/extensions.cc 的 kExtensions[]，共 31 项）。
// 洗牌就是对这个表的下标做 Fisher-Yates，再按洗出来的次序取用；
// pre_shared_key(41) 不在表里——它在循环之后单独追加，永远最后，我们不发 PSK 所以不用管。
// GREASE 也不在表里：第一个（空体）永远在最前、第二个（1 字节）永远在最后。
export const CANONICAL_EXT_ORDER = [
  0,        // server_name
  0xfe0d,   // encrypted_client_hello
  23,       // extended_master_secret
  0xff01,   // renegotiate
  10,       // supported_groups
  11,       // ec_point_formats
  35,       // session_ticket
  16,       // application_layer_protocol_negotiation
  5,        // status_request
  13,       // signature_algorithms
  13172,    // next_proto_neg
  18,       // certificate_timestamp
  30032,    // channel_id
  14,       // srtp
  51,       // key_share
  45,       // psk_key_exchange_modes
  42,       // early_data
  43,       // supported_versions
  44,       // cookie
  57,       // quic_transport_parameters
  0xffa5,   // quic_transport_parameters_legacy
  27,       // cert_compression
  34,       // delegated_credential
  17613,    // application_settings (ALPS)
  17513,    // application_settings_old
  47,       // certificate_authorities
  0x8a3b,   // pake
  0xca34,   // trust_anchors
  19,       // client_cert_type
  20,       // server_cert_type
  4832,     // server_padding
];

// 抓包里那把 GREASE 值。真 Chrome 每次连接随机生成；curl_cffi 是固定值，
// 我们照搬固定值——先保证和 curl_cffi 的指纹逐字节一致，随机化另说。
export const GREASE = { ext1: 0xcaca, group: 0xfafa, version: 0xaaaa, extLast: 0xeaea };
