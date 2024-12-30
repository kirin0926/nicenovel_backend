require('dotenv').config();
const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = new Koa();
const router = new Router();

// 添加 CORS 中间件
app.use(cors({
  origin: '*', // 允许所有来源，生产环境建议设置具体的域名
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposeHeaders: ['WWW-Authenticate', 'Server-Authorization'],
  maxAge: 5,
  credentials: true,
}));

// 修改 bodyParser 配置
app.use(bodyParser({
  enableTypes: ['json', 'text'],
  extendTypes: {
    text: ['application/json'],
  },
  jsonLimit: '10mb',
  textLimit: '10mb',
  // 添加这个选项来保留原始请求体
  rawBody: true
}));

// 使用您的 Stripe 密钥
const stripe = Stripe('sk_test_51PBXHTDISTrmdpg8MYsAFYtENOoFKIANKK3uV10en5Y3brlmYgADYT4JTVfZ5gSCtrf7x97fnTZ14VD3G2qm0ThR00TMFcKMnW');

// 在现有的导入语句下面添加 Supabase 配置
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

// 注册路由
app.use(router.routes()).use(router.allowedMethods());

// 创建订阅产品和价格的 API
router.post('/create-subscription-products', async (ctx) => {
  try {
    // 创建一个阅读订阅产品
    const readingProduct = await stripe.products.create({
      name: 'niceNovel_Svip',
      description: '享受无限制阅读权限',
    });

    // 为同一产品创建多个价格选项
    const price3Days = await stripe.prices.create({
      product: readingProduct.id,
      unit_amount: 990, // $9.90
      currency: 'usd',
      recurring: {
        interval: 'day',
        interval_count: 3,
      },
      nickname: '3天订阅',
    });

    const price7Days = await stripe.prices.create({
      product: readingProduct.id,
      unit_amount: 1499, // $14.99
      currency: 'usd',
      recurring: {
        interval: 'day',
        interval_count: 7,
      },
      nickname: '7天订阅',
    });

    // 将价格信息保存到 Supabase
    const { data: savedPrices, error: dbError } = await supabase
      .from('stripe_prices')
      .insert([
        {
          price_id: price3Days.id,//price_id 是价格ID
          product_id: readingProduct.id,//product_id 是产品ID
          nickname: price3Days.nickname,//nickname 是价格昵称
          unit_amount: price3Days.unit_amount,//unit_amount 是价格单位金额
          currency: price3Days.currency,//currency 是价格货币
          interval: price3Days.recurring.interval,//interval 是价格间隔
          interval_count: price3Days.recurring.interval_count//interval_count 是价格间隔计数
        },
        {
          price_id: price7Days.id,
          product_id: readingProduct.id,
          nickname: price7Days.nickname,
          unit_amount: price7Days.unit_amount,
          currency: price7Days.currency,
          interval: price7Days.recurring.interval,
          interval_count: price7Days.recurring.interval_count
        }
      ]);

    if (dbError) {
      console.error('Error saving to database:', dbError);
      ctx.status = 500;
      ctx.body = {
        code: 500,
        message: 'Database error',
        error: dbError.message
      };
      return;
    }

    ctx.body = {
      code: 200,
      message: 'success',
      data: {
        product: readingProduct,
        prices: {
          threeDays: price3Days,
          sevenDays: price7Days,
        },
        savedPrices
      },
    };
  } catch (error) {
    console.error('Error creating subscription products:', error);
    ctx.status = 500;
    ctx.body = { 
      code: 500,
      message: error.message 
    };
  }
});

// 获取所有价格信息的 API
router.get('/subscription-prices', async (ctx) => {
  try {
    const { data: prices, error } = await supabase
      .from('stripe_prices')
      .select('*')
      .order('unit_amount', { ascending: true });

    if (error) {
      throw error;
    }

    ctx.body = {
      code: 200,
      message: 'success',
      data: prices
    };

  } catch (error) {
    console.error('Error fetching prices:', error);
    ctx.status = 500;
    ctx.body = {
      code: 500,
      message: error.message
    };
  }
});

// 创建订阅的 API
router.post('/create-subscription', async (ctx) => {
  try {
    const { priceId, email } = ctx.request.body;
    // 验证必需的参数
    if (!priceId || !email) {
      ctx.status = 400;
      ctx.body = {
        code: 400,
        message: 'Missing required parameters: priceId or email'
      };
      return;
    }

    // 创建 Stripe 客户
    const customer = await stripe.customers.create({
      email: email,
    });

    // 修改这里的订阅创建代码
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price: priceId,
          quantity: 1  // 明确指定数量
        }
      ],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    ctx.body = {
      code: 200,
      message: 'success',
      data: {
        subscriptionId: subscription.id,
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      }
    };
  } catch (error) {
    console.error('Error creating subscription:', error);
    ctx.status = 500;
    ctx.body = {
      code:500,
      message:error.message
    };
  }
});

// 处理 Stripe Webhook
router.post('/webhook', async (ctx) => {
  const sig = ctx.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      ctx.request.rawBody, // 原始的请求体，确保使用了中间件保留原始 body
      sig,
      'your-webhook-secret-here'
    );

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent);
      // 处理支付成功的逻辑
    }

    ctx.status = 200;
  } catch (err) {
    console.error('Webhook Error:', err.message);
    ctx.status = 400;
  }
});

// 启动服务器
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
