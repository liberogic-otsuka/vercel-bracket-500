import type {
  GetStaticPaths,
  GetStaticPropsContext,
  InferGetStaticPropsType,
  NextPage,
} from 'next'

export const getStaticProps = async (ctx: GetStaticPropsContext) => {
  return {
    props: { id: (ctx.params?.id as string | undefined) ?? null },
    revalidate: 60,
  }
}

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    fallback: 'blocking',
    paths: [],
  }
}

const Page: NextPage<InferGetStaticPropsType<typeof getStaticProps>> = (props) => {
  return <div>id: {String(props.id)}</div>
}

export default Page
